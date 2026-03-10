import { VectorStoreService } from '@/services/analysis/vector-store.service';
import { ModelBaseService } from '@/services/core/model-base.service';

import { Container, Singleton } from 'typescript-ioc';
import { PromptTemplate } from '@langchain/core/prompts';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { RunnableSequence } from '@langchain/core/runnables';
import type { CodeIssueInterface } from '@/services/analysis/code-analyzer.service';
import type { ScmChangeInterface } from '@/interfaces/scm-change.interface';

export interface AICodeIssueRecommendation extends CodeIssueInterface {
  type: 'quality' | 'security' | 'performance' | 'best_practice';
  /** Что произойдёт, если не исправить */
  impact?: string;
  /** Пример исправленного кода (если применимо) */
  codeExample?: string;
}

interface AIPartialRecommendation {
  type?: AICodeIssueRecommendation['type'];
  message?: string;
  suggestion?: string;
  impact?: string;
  codeExample?: string;
}

interface PushCommitSummaryInput {
  id: string;
  message: string;
  files: string[];
}

interface SummaryChangeItem {
  file: string;
  diff: string;
  newContent: string;
}

@Singleton
export class AIService extends ModelBaseService {
  private readonly codeReviewPrompt: PromptTemplate;

  private readonly pushSummaryPrompt: PromptTemplate;

  private readonly mergeSummariesPrompt: PromptTemplate;

  /** Лимит символов на один батч изменений (≈ лимит токенов × 4), чтобы не превышать контекст модели. */
  private static readonly MAX_CHARS_PER_BATCH = 22000;

  /** Минимальный интервал между запросами к модели (не более 1 запроса в секунду). */
  private static readonly MIN_REQUEST_INTERVAL_MS = 1000;

  private readonly vectorStoreService = Container.get(VectorStoreService);

  public constructor() {
    super();

    this.codeReviewPrompt = PromptTemplate.fromTemplate(`
      Ты — опытный ревьюер TypeScript/Node.js кода.
      
      Тебе переданы:
      - список проблем статического анализа (ESLint/TS/security/perf);
      - отдельные логические кандидаты на потенциальные ошибки (изменения схем сущностей и сигнатур функций);
      - несколько похожих по смыслу фрагментов кода из проекта.
      
      Проблемы (JSON-массив объектов с полями как минимум "file", "line", "severity", "message", "rule", "suggestion"):
      {issues}
      
      Похожие фрагменты кода (JSON-массив, каждый элемент содержит "file", "score", "snippet"):
      {projectPatterns}
      
      ОСОБЫЕ ПРАВИЛА ДЛЯ ЛОГИЧЕСКИХ ИЗМЕНЕНИЙ:
      - Если rule === "logical-entity-schema-change":
        - поле suggestion содержит JSON с деталями изменения схемы сущности:
          {{
            "kind": "entity-schema-change",
            "entityName": string,
            "file": string,
            "addedProperties": [{{ "name": string, "type": string, "decorators": string[] }}],
            "removedProperties": [{{ "name": string, "type": string, "decorators": string[] }}]
          }}
        - Твоя задача — логически проверить по коду проблемы и похожим фрагментам, не создает ли это риск:
          - где-то создаётся сущность без новых полей;
          - где-то формируется или читается объект, не учитывающий новые поля.
        - Если риск существенный (может привести к падению, неконсистентным данным, ошибкам миграций) — сформулируй проблему и рекомендацию с приоритетом.
      
      - Если rule === "logical-function-signature-change":
        - поле suggestion содержит JSON с деталями изменения сигнатуры:
          {{
            "kind": "function-signature-change",
            "functionName": string,
            "className"?: string,
            "file": string,
            "addedParameters": [{{ "name": string, "type": string, "optional": boolean, "hasDefault": boolean }}],
            "removedParameters": [{{ "name": string, "type": string, "optional": boolean, "hasDefault": boolean }}]
          }}
        - Твоя задача — логически проверить по коду проблемы и похожим фрагментам, не остались ли вызовы функции/метода по старой схеме
          (без новых параметров, с устаревшим порядком аргументов и т.п.).
        - Если риск существенный (ошибки выполнения, падения, некорректная бизнес-логика) — обязательно выдели это как важную рекомендацию.
      
      Для КАЖДОЙ входной проблемы верни ОДИН элемент массива JSON СТРОГО такого вида:
      [
        {{
          "type": "quality|security|performance|best_practice",
          "message": "Краткое описание проблемы (1 предложение, по-русски, не более 160 символов)",
          "suggestion": "Краткая рекомендация, как исправить (1 предложение, по-русски, не более 160 символов)",
          "impact": "К чему может привести в проде, если не исправить (1 предложение, по-русски, не более 160 символов)",
          "codeExample": "Короткий пример исправленного кода, если уместно"
        }}
      ]
      
      ТРЕБОВАНИЯ:
      - Пиши ТОЛЬКО по-русски.
      - Не выдумывай детали, которых нет в коде.
      - Будь особенно внимателен к проблемам с rule "logical-entity-schema-change" и "logical-function-signature-change":
        если виден потенциальный продакшн-риск, явно опиши его в поле "impact" и сделай "message"/"suggestion" максимально конкретными.
      - Не используй Markdown и текст вне JSON.
      - Выведи ТОЛЬКО JSON-массив без лишнего текста.
    `);
      
    this.pushSummaryPrompt = PromptTemplate.fromTemplate(`
      Ты — ведущий разработчик TypeScript/Node.js.
      
      Тебе даны:
      - список git-коммитов (сообщения и затронутые файлы);
      - список найденных проблем в коде (severity, type, message, impact, suggestion);
      - список изменений по файлам (JSON-массив объектов с полями "file", "diff", "newContent").
        "diff" — unified diff (строки с + добавлены, с - удалены). "newContent" — полный текст новой версии файла для контекста.
      
      Коммиты (JSON):
      {commits}
      
      Проблемы (JSON):
      {issues}
      
      Изменения в коде (JSON):
      {changes}
      
      Задача: на основе DIFF опиши суть изменений по-русски. Смотри на строки с + и -: что добавили, что убрали.
      Не описывай весь файл целиком — только то, что реально изменилось. Опирайся на "diff"; "newContent" — для контекста при необходимости.
      
      Ответ: максимум 3-4 коротких предложения, по-русски, без Markdown и списков.
      Если есть важные проблемы по анализу — кратко упомяни. Если критичных нет — можно написать, что критичных проблем не обнаружено.
      
      ТРЕБОВАНИЯ: Пиши ТОЛЬКО по-русски, простой текст. Опирайся на "diff".
    `);

    this.mergeSummariesPrompt = PromptTemplate.fromTemplate(`
      Ты — редактор технических текстов.
      
      Тебе даны несколько кратких описаний изменений в коде (по частям одного и того же push/коммита).
      
      Части описаний (каждая — 1-4 предложения):
      {summaries}
      
      Задача: объедини их в один связный текст из 3-5 предложений по-русски. Сохрани все важные факты, убери повторы.
      Без Markdown и списков — только простой текст. Пиши ТОЛЬКО по-русски.
    `);
  }

  public getRecommendations = async (issues: CodeIssueInterface[]): Promise<AICodeIssueRecommendation[]> => {
    if (!issues.length) {
      return [];
    }

    const llm = await this.getLlm();

    const chain = RunnableSequence.from([
      this.codeReviewPrompt,
      llm,
      new StringOutputParser(),
    ]);

    // Для каждого issue ищем похожий код в текущем MR
    const projectPatterns: { file: string; score: number; snippet: string; }[][] = [];

    // последовательные запросы к векторному хранилищу с контролируемым интервалом
    for (let issueIndex = 0; issueIndex < issues.length; issueIndex += 1) {
      if (issueIndex > 0) {
        await this.rateLimitDelay();
      }

      const issue = issues[issueIndex];

      const similarCodeList = await this.vectorStoreService.findSimilarCode(
        `${issue.file}:${issue.line} ${issue.message}`,
        3,
      );

      const mappedSimilarCodeList = similarCodeList.map((similarCodeEntry) => ({
        file: similarCodeEntry.file,
        score: similarCodeEntry.score,
        snippet: similarCodeEntry.content.slice(0, 800),
      }));

      projectPatterns.push(mappedSimilarCodeList);
    }

    const result = await chain.invoke({
      issues: JSON.stringify(issues),
      projectPatterns: JSON.stringify(projectPatterns),
    });

    let partials: AIPartialRecommendation[] = [];

    try {
      const jsonText = this.extractJsonPayload(result);
      const parsed = JSON.parse(jsonText) as unknown;
      if (Array.isArray(parsed)) {
        partials = parsed as AIPartialRecommendation[];
      }
    } catch {
      // Если модель вернула невалидный JSON, просто вернём "плоские" рекомендации без обогащения,
      // чтобы не ронять весь пайплайн.
      partials = [];
    }

    return issues.map((issue, index) => {
      const ai = partials[index] ?? {};

      return {
        ...issue,
        type: ai.type ?? 'quality',
        // message: prefer AI text but fall back to original
        message: ai.message ?? issue.message,
        // keep original ESLint severity, but suggestion may be refined
        severity: issue.severity,
        suggestion: ai.suggestion ?? issue.suggestion,
        impact: ai.impact,
        codeExample: ai.codeExample,
        // preserve rule and file/line from original issue
      };
    });
  };

  public generateTestCases = async (code: string): Promise<string[]> => {
    const prompt = `
Generate unit test case descriptions for this TypeScript code:
${code}

Return JSON array of strings, e.g. ["should do X", "should handle Y"].
    `;

    const llm = await this.getLlm();

    const response = await llm.invoke(prompt);

    const content = typeof response.content === 'string'
      ? response.content
      : JSON.stringify(response.content);

    const parsed = JSON.parse(content) as unknown;

    if (Array.isArray(parsed)) {
      return parsed.map((item) => String(item));
    }

    return [];
  };

  /**
   * Краткое человеческое описание того, что изменил push,
   * с учётом коммитов, diff'ов и найденных проблем/рекомендаций.
   * При большом объёме изменений отправляет несколько запросов по батчам и объединяет результат.
   */
  public summarizePush = async (commits: PushCommitSummaryInput[], recommendations: AICodeIssueRecommendation[], changes: ScmChangeInterface[]): Promise<string> => {
    if (!commits.length) {
      return '';
    }

    const llm = await this.getLlm();

    const summaryChain = RunnableSequence.from([
      this.pushSummaryPrompt,
      llm,
      new StringOutputParser(),
    ]);
    const mergeChain = RunnableSequence.from([
      this.mergeSummariesPrompt,
      llm,
      new StringOutputParser(),
    ]);

    const commitsStr = JSON.stringify(commits);
    const issuesStr = JSON.stringify(recommendations);
    const overhead = commitsStr.length + issuesStr.length + 500;

    const batches = this.buildSummaryBatches(changes, AIService.MAX_CHARS_PER_BATCH - overhead);

    const summaries: string[] = [];

    // не более 1 запроса в секунду к модели
    for (let i = 0; i < batches.length; i += 1) {
      if (i > 0) {
        await this.rateLimitDelay();
      }

      const result = await summaryChain.invoke({
        commits: commitsStr,
        issues: issuesStr,
        changes: JSON.stringify(batches[i]),
      });

      const text = typeof result === 'string' ? result.trim() : String(result);
      if (text) {
        summaries.push(text);
      }
    }

    if (!summaries.length) {
      return '';
    }
    if (summaries.length === 1) {
      return summaries[0];
    }

    await this.rateLimitDelay();

    const merged = await mergeChain.invoke({
      summaries: summaries.map((summary, i) => `[Часть ${i + 1}]: ${summary}`).join('\n\n'),
    });

    return typeof merged === 'string' ? merged.trim() : String(merged);
  };

  private getLlm = async () => this.getChatModel();

  private rateLimitDelay(): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, AIService.MIN_REQUEST_INTERVAL_MS);
    });
  }

  private buildSummaryBatches = (changes: ScmChangeInterface[], maxCharsPerBatch: number): SummaryChangeItem[][] => {
    const batches: SummaryChangeItem[][] = [];
    let current: SummaryChangeItem[] = [];
    let currentSize = 0;

    for (const change of changes) {
      const item = {
        file: change.file,
        diff: change.diff,
        newContent: change.newContent,
      };
      const itemSize = JSON.stringify(item).length;

      if (currentSize + itemSize > maxCharsPerBatch && current.length > 0) {
        batches.push(current);
        current = [];
        currentSize = 0;
      }

      current.push(item);
      currentSize += itemSize;
    }

    if (current.length > 0) {
      batches.push(current);
    }

    return batches;
  };

  private extractJsonPayload = (raw: string): string => {
    // 1. Если модель вернула fenced-блок ```json ... ``` — вырежем его
    const fencedMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fencedMatch?.[1]) {
      return fencedMatch[1].trim();
    }

    // 2. Иначе попробуем найти первый JSON-объект или массив в тексте
    const jsonMatch = raw.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (jsonMatch?.[1]) {
      return jsonMatch[1].trim();
    }

    // 3. В крайнем случае вернём как есть — JSON.parse выбросит ошибку, которую мы выше перехватим
    return raw.trim();
  };
}
