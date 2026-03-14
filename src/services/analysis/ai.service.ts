import * as path from 'path';
import { VectorStoreService } from '@/services/analysis/vector-store.service';
import { ModelBaseService } from '@/services/core/model-base.service';

import { Container, Singleton } from 'typescript-ioc';
import { PromptTemplate } from '@langchain/core/prompts';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { RunnableSequence } from '@langchain/core/runnables';
import ts from 'typescript';
import type { CodeIssueInterface } from '@/services/analysis/code-analyzer.service';
import type { ScmChangeInterface } from '@/interfaces/scm-change.interface';

export type GetFileContentFn = (filePath: string) => Promise<string>;

interface TsconfigPathsInterface {
  baseUrl: string;
  paths: Record<string, string[]>;
}

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

  private readonly logicalDataLoadingPrompt: PromptTemplate;

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
      
      - Если rule === "logical-query-result-mismatch":
        - это проблема, найденная логическим анализом ИИ: код обращается к полям/связям результата запроса, которые, по смыслу кода запроса, не загружаются (TypeORM relations/join, Knex select/join, raw SQL, Prisma include/select и т.д.). В рантайме — undefined или ошибка.
        - Рекомендация: добавить недостающие поля/связи в выборку. Выдели это как критичную ошибку в "impact".
      
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
      - Будь особенно внимателен к проблемам с rule "logical-entity-schema-change", "logical-function-signature-change" и "logical-query-result-mismatch":
        если виден потенциальный продакшн-риск, явно опиши его в поле "impact" и сделай "message"/"suggestion" максимально конкретными.
      - Не используй Markdown и текст вне JSON.
      - Выведи ТОЛЬКО JSON-массив без лишнего текста.
    `);

    this.logicalDataLoadingPrompt = PromptTemplate.fromTemplate(`
      Ты — опытный ревьюер кода. Выполни логический анализ загрузки данных.
      
      Тебе переданы файлы (поле "file" — путь, "content" — содержимое). Часть из них — изменённые в MR/коммите, часть — файлы, в которые из изменённых передаётся результат запроса (импортируемые модули). Все их нужно анализировать вместе.
      
      В файлах могут быть запросы к БД: TypeORM (findOne/find с relations, createQueryBuilder с join'ами), Knex, raw SQL, Prisma, Drizzle и т.д. Результат запроса может сохраняться в переменную и передаваться в другую функцию — в том числе в функцию из другого файла. Обращение к полям/связям может быть как в том же файле, где запрос, так и в файле, куда переменная передана параметром.
      
      Задача: найди все места, где к результату запроса (или к аргументу, в который он передан) обращаются по свойствам/связям, которые запрос не загружает (включая обход массивов и вложенные поля). Это приведёт к undefined или ошибке в рантайме.
      
      Файлы для анализа (JSON-массив объектов с полями "file", "content"):
      {files}
      
      Верни JSON-массив проблем СТРОГО такого вида (если проблем нет — пустой массив []):
      [
        {{ "file": "путь/к/файлу", "line": номер_строки_где_обращение_к_данным, "message": "краткое описание по-русски" }}
      ]
      
      ТРЕБОВАНИЯ:
      - Пиши ТОЛЬКО по-русски в поле message.
      - Указывай реальные file и line по коду (в том числе в файле, куда передана константа).
      - Не выдумывай проблем: только явное несоответствие «запрос не подгружает X, а код читает X».
      - Выведи ТОЛЬКО JSON-массив без Markdown и текста вне JSON.
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

  /**
   * Логический анализ загрузки данных: модель проверяет, что код не обращается к полям/связям,
   * которые не загружаются запросом (любой стиль: TypeORM, Knex, Prisma, raw SQL и т.д.).
   * Если передан getFileContent, в контекст добавляются файлы, импортируемые из изменённых
   * (куда может прокидываться результат запроса).
   */
  public getLogicalDataLoadingIssues = async (changes: ScmChangeInterface[], getFileContent?: GetFileContentFn): Promise<CodeIssueInterface[]> => {
    const allowedExtensions = ['.ts', '.tsx'];
    const filesPayload: { file: string; content: string; }[] = [];
    const seenPaths = new Set<string>();
    let totalChars = 0;

    for (const change of changes) {
      const extension = change.file.slice(change.file.lastIndexOf('.')).toLowerCase();
      if (!allowedExtensions.includes(extension) || !change.newContent?.trim()) {
        continue;
      }
      const content = change.newContent.slice(0, 12000);
      if (totalChars + content.length > AIService.MAX_CHARS_PER_BATCH) {
        break;
      }
      const normalizedPath = path.normalize(change.file).replace(/\\/g, '/');
      if (!seenPaths.has(normalizedPath)) {
        seenPaths.add(normalizedPath);
        filesPayload.push({ file: change.file, content });
        totalChars += content.length;
      }
    }

    if (getFileContent && filesPayload.length) {
      const tsconfigPaths = await this.loadTsconfigPaths(getFileContent);
      const pathResolver = this.buildPathResolver(tsconfigPaths);
      const importedPaths = this.collectImportedPathsFromChanges(changes, pathResolver);
      for (const resolvedPathBase of importedPaths) {
        if (totalChars >= AIService.MAX_CHARS_PER_BATCH) {
          break;
        }
        if (resolvedPathBase.includes('node_modules')) {
          continue;
        }
        let content: string | null = null;
        let resolvedWithExt = '';
        for (const extension of ['.ts', '.tsx']) {
          const candidate = resolvedPathBase + extension;
          const normalized = path.normalize(candidate).replace(/\\/g, '/');
          if (seenPaths.has(normalized)) {
            content = null;
            break;
          }
          try {
            content = await getFileContent(candidate);
            resolvedWithExt = candidate;
            break;
          } catch {
            continue;
          }
        }
        if (content && content.trim() && resolvedWithExt) {
          const slice = content.slice(0, 12000);
          if (totalChars + slice.length <= AIService.MAX_CHARS_PER_BATCH) {
            seenPaths.add(path.normalize(resolvedWithExt).replace(/\\/g, '/'));
            filesPayload.push({ file: resolvedWithExt, content: slice });
            totalChars += slice.length;
          }
        }
      }
    }

    if (filesPayload.length === 0) {
      return [];
    }

    const llm = await this.getLlm();
    const chain = RunnableSequence.from([
      this.logicalDataLoadingPrompt,
      llm,
      new StringOutputParser(),
    ]);

    const result = await chain.invoke({
      files: JSON.stringify(filesPayload),
    });

    let items: Array<{ file: string; line: number; message: string }> = [];

    try {
      const jsonText = this.extractJsonPayload(result);
      const parsed = JSON.parse(jsonText) as unknown;
      if (Array.isArray(parsed)) {
        items = parsed.filter(
          (item): item is { file: string; line: number; message: string } =>
            typeof item === 'object' &&
            item !== null &&
            'file' in item &&
            'line' in item &&
            'message' in item,
        );
      }
    } catch {
      return [];
    }

    return items.map((item) => ({
      file: item.file,
      line: item.line,
      severity: 'error' as const,
      message: item.message,
      rule: 'logical-query-result-mismatch',
    }));
  };

  /** Пытается загрузить baseUrl и paths из tsconfig.json в корне репозитория. */
  private loadTsconfigPaths = async (getFileContent: GetFileContentFn): Promise<TsconfigPathsInterface | null> => {
    try {
      const raw = await getFileContent('tsconfig.json');
      const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
      const json = JSON.parse(stripped) as { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
      const baseUrl = json.compilerOptions?.baseUrl ?? '';
      const paths = json.compilerOptions?.paths;
      if (!paths || typeof paths !== 'object') {
        return baseUrl ? { baseUrl, paths: {} } : null;
      }
      return { baseUrl, paths };
    } catch {
      return null;
    }
  };

  /** Строит резолвер: (specifier, fromFile) => путь без расширения или null. */
  private buildPathResolver = (tsconfig: TsconfigPathsInterface | null): (specifier: string, fromFile: string) => string | null => {
    return (specifier: string, fromFile: string): string | null => {
      if (specifier.startsWith('.')) {
        const dir = path.posix.dirname(fromFile);
        return path.posix.normalize(path.posix.join(dir, specifier));
      }
      if (tsconfig) {
        const sortedKeys = Object.keys(tsconfig.paths).sort((a, b) => b.length - a.length);
        for (const pattern of sortedKeys) {
          const mappings = tsconfig.paths[pattern];
          if (!Array.isArray(mappings) || mappings.length === 0) {
            continue;
          }
          const prefix = pattern.replace(/\*$/, '');
          if (prefix !== pattern && specifier.startsWith(prefix)) {
            const rest = specifier.slice(prefix.length);
            const template = mappings[0];
            const resolved = template.includes('*') ? template.replace('*', rest) : template;
            const base = tsconfig.baseUrl ? path.posix.normalize(tsconfig.baseUrl) : '';
            return base ? path.posix.join(base, resolved) : path.posix.normalize(resolved);
          }
          if (pattern === specifier || (pattern.endsWith('*') && specifier.startsWith(pattern.slice(0, -1)))) {
            const template = mappings[0];
            const rest = pattern.endsWith('*') ? specifier.slice(pattern.length - 1) : '';
            const resolved = template.includes('*') ? template.replace('*', rest) : template;
            const base = tsconfig.baseUrl ? path.posix.normalize(tsconfig.baseUrl) : '';
            return base ? path.posix.join(base, resolved) : path.posix.normalize(resolved);
          }
        }
      }
      // Только алиас @/ считаем путём внутри репозитория; @scope/name — внешние npm-пакеты, не резолвим
      if (specifier.startsWith('@/')) {
        return path.posix.normalize('src/' + specifier.slice(2));
      }
      return null;
    };
  };

  /** Собирает пути файлов, импортируемых из изменённых (относительные и алиасы), без расширения. */
  private collectImportedPathsFromChanges = (
    changes: ScmChangeInterface[],
    pathResolver: (specifier: string, fromFile: string) => string | null,
  ): string[] => {
    const allowedExtensions = ['.ts', '.tsx'];
    const resultSet = new Set<string>();

    for (const change of changes) {
      const extension = change.file.slice(change.file.lastIndexOf('.')).toLowerCase();
      if (!allowedExtensions.includes(extension) || !change.newContent?.trim()) {
        continue;
      }
      const sourceFile = ts.createSourceFile(
        change.file,
        change.newContent,
        ts.ScriptTarget.Latest,
        true,
      );

      const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
          const specifier = node.moduleSpecifier.text;
          if (specifier.includes('node_modules') || (specifier.length > 0 && !specifier.startsWith('.') && !specifier.startsWith('@') && !specifier.includes('/'))) {
            return;
          }
          const resolved = pathResolver(specifier, change.file);
          if (resolved) {
            resultSet.add(resolved);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }

    return Array.from(resultSet);
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
