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

export interface LogicalDataLoadingOptions {
  getFileContent?: GetFileContentFn;
  /** Список путей исходных файлов репозитория для поиска файлов, которые импортируют изменённые (места вызова). */
  getSourceFilePaths?: () => Promise<string[]>;
}

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

interface ParameterPropertyAccessEntry {
  parameterIndex: number;
  propertyPath: string;
  requiresExactRelation: boolean;
  line: number;
}

interface ParameterPropertyAccessTarget {
  key: string;
  kind: 'function' | 'method';
  name: string;
  className?: string;
  filePath: string;
  parameterNames: string[];
  destructuredProperties: string[];
  propertyAccesses: string[];
  propertyAccessEntries: ParameterPropertyAccessEntry[];
}

interface QueryRelationSource {
  filePath: string;
  variableName: string;
  relationPaths: string[];
  sourceText: string;
}

interface CallSiteArgumentInfo {
  index: number;
  name: string;
  relationPaths: string[];
  sourceText: string;
}

interface CallSiteTraceInfo {
  file: string;
  callee: string;
  arguments: CallSiteArgumentInfo[];
}

interface TraceabilityPayloadItem {
  target: string;
  definitionFile: string;
  parameterNames: string[];
  destructuredProperties: string[];
  propertyAccesses: string[];
  callSiteFiles: string[];
  callSites: CallSiteTraceInfo[];
  propertyAccessEntries: ParameterPropertyAccessEntry[];
}

@Singleton
export class AIService extends ModelBaseService {
  protected readonly TAG = 'AIService';

  private readonly codeReviewPrompt: PromptTemplate;

  private readonly logicalDataLoadingPrompt: PromptTemplate;

  private readonly pushSummaryPrompt: PromptTemplate;

  private readonly mergeSummariesPrompt: PromptTemplate;

  private readonly unifiedAnalysisPrompt: PromptTemplate;

  /** Контекст модели 262K токенов; ≈4 символа на токен. Резерв под ответ и системный промпт ~50K токенов → ~848K символов на батч. */
  private static readonly MAX_CHARS_PER_BATCH = 848000;

  /** Лимит символов для анализа загрузки данных (тот же контекст 262K). */
  private static readonly LOGICAL_DATA_LOADING_MAX_CHARS = 848000;

  /** Максимум символов на один файл при отправке в анализ загрузки данных (обрезание только очень больших файлов). */
  private static readonly LOGICAL_DATA_LOADING_MAX_CHARS_PER_FILE = 80000;

  /** Минимальный интервал между запросами к модели (не более 1 запроса в секунду). */
  private static readonly MIN_REQUEST_INTERVAL_MS = 1000;

  /** Максимум символов контекста для единого AI-анализа изменений. */
  private static readonly UNIFIED_ANALYSIS_MAX_CHARS = 400000;

  /** Максимум issue, для которых выполняется векторный поиск похожего кода в getRecommendations. */
  private static readonly MAX_ISSUES_FOR_VECTOR_SEARCH = 15;

  /** Строка содержит обращение к свойству (obj.prop или obj?.prop). */
  private static readonly PROPERTY_ACCESS_LINE_PATTERN = /\.\s*\w|\?\s*\.\s*\w|\{\s*[^}]*\}\s*=|\(\s*\{[^)]*\}\s*\)/;

  private readonly vectorStoreService = Container.get(VectorStoreService);

  public constructor() {
    super();

    this.codeReviewPrompt = PromptTemplate.fromTemplate(`
      Ты — опытный ревьюер TypeScript/Node.js кода.
      
      Тебе переданы только критические кандидаты (error/security): проблемы статического анализа и логические кандидаты на ошибки в рантайме.
      - список проблем (file, line, message, rule, suggestion);
      - похожие по смыслу фрагменты кода из проекта.
      
      Проблемы (JSON-массив):
      {issues}
      
      Похожие фрагменты кода (JSON-массив, каждый элемент: "file", "score", "snippet"):
      {projectPatterns}
      
      ВАЖНО: Возвращай рекомендации только для тех проблем, которые гарантированно приведут к ошибке в рантайме, падению или уязвимости. Не включай quality, best_practice, стилистику — только type "security" или проблемы с реальным риском падения/некорректных данных.
      
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
      
      Для КАЖДОЙ входной проблемы верни ОДИН элемент массива JSON СТРОГО такого вида (только если проблема реально приведёт к ошибке в рантайме или уязвимости; иначе для этой проблемы верни пустой объект {{}} или не включай в массив):
      [
        {{
          "type": "security" или "performance" (только если приведёт к падению/ошибке; не используй quality/best_practice),
          "message": "Краткое описание проблемы (1 предложение, по-русски, не более 160 символов)",
          "suggestion": "Краткая рекомендация, как исправить (1 предложение, по-русски, не более 160 символов)",
          "impact": "К чему приведёт в проде: ошибка в рантайме, падение, уязвимость (1 предложение, по-русски, не более 160 символов)",
          "codeExample": "Короткий пример исправленного кода, если уместно"
        }}
      ]
      
      ТРЕБОВАНИЯ:
      - Пиши ТОЛЬКО по-русски.
      - Включай в массив только критические проблемы (ошибка в рантайме, падение, security). Не включай догадки, стилистику, quality, best_practice.
      - Будь особенно внимателен к rule "logical-entity-schema-change", "logical-function-signature-change", "logical-query-result-mismatch": включай только если есть реальный риск падения или некорректных данных.
      - Не используй Markdown и текст вне JSON.
      - Выведи ТОЛЬКО JSON-массив без лишнего текста.
    `);

    this.logicalDataLoadingPrompt = PromptTemplate.fromTemplate(`
      Ты — AI-агент по анализу безопасного доступа к свойствам объектов в TypeScript/Node.js.
      
      Тебе переданы:
      1) ГЛАВНЫЕ ФАЙЛЫ (источники данных) — здесь формируются/загружаются объекты (БД: TypeORM find/findOne с relations, createQueryBuilder с join, Prisma include/select, Knex и т.д.; API/кэш; явная инициализация).
      2) ФАЙЛЫ ИСПОЛЬЗОВАНИЯ — код, где эти объекты используются или передаются дальше.
      3) TRACEABILITY (JSON) — для каждой функции/метода (target): definitionFile (где определена), propertyAccessEntries (parameterIndex, propertyPath, line — где в коде обращаются к свойству параметра), callSites (где вызывают эту функцию: file, callee, arguments с relationPaths и sourceText для аргументов из find/findOne).
      
      УЧИТЫВАЙ ЦЕПОЧКУ ВЫЗОВОВ И СВЯЗАННЫЕ ФАЙЛЫ:
      У тебя есть callSites (кто вызывает функцию) и связанные файлы (sourceFiles, usageFiles, callSiteFiles). Если свойство подгружено в верхней (вызывающей) функции — объект уже приходит с этим полем. НЕ сообщай проблему, если:
      - в любом из callSites для этого target аргумент имеет relationPaths, покрывающие propertyPath (значит, в том вызове объект загружен с нужной связью);
      - в файле вызова (callSites[].file) или в definitionFile в коде загрузки (find/findOne/relations/join/include) указана эта связь;
      - объект создаётся или подгружается с propertyPath в любом из переданных тебе файлов (главные или использования).
      Сообщай проблему только если ни в одном месте цепочки вызовов и ни в одном связанном файле свойство не загружается.
      
      ГЛАВНОЕ ПРАВИЛО — СВЯЗЫВАЙ КАЖДУЮ ПРОБЛЕМУ С КОНКРЕТНОЙ ЦЕПОЧКОЙ:
      Сообщай проблему ТОЛЬКО если ты для неё явно установил:
      (1) Место использования: файл и строка (file, line) — где в коде обращаются к свойству объекта (должно совпадать с одним из propertyAccessEntries в TRACEABILITY).
      (2) Источник объекта: откуда объект попал в эту функцию — либо definitionFile (объект создаётся в том же файле), либо один из callSites[].file и конкретный аргумент с relationPaths (объект пришёл из вызова).
      (3) Свойство: propertyPath — какая цепочка свойств используется (например order.delivery.address).
      (4) Доказательство несоответствия: ни в источнике, ни в других callSites, ни в связанных файлах НЕТ загрузки этого propertyPath (relations/include/select/join); для вложенных связей нужна полная цепочка.
      
      Если не можешь для данной строки заполнить sourceFile, sourceLine и propertyPath по данным TRACEABILITY и коду — проблему НЕ сообщай. Не помечай объекты «на всякий случай».
      
      УЧЁТ ТИПИЗАЦИИ (TypeScript):
      - Смотри на объявления типов в коде: interface, type, типы параметров и возвращаемых значений.
      - ОБЯЗАТЕЛЬНЫЕ СВОЙСТВА (prop: Type, без ?): если свойство в типе объявлено как обязательное (не опциональное), НЕ сообщай проблему «свойство может быть не загружено» — контракт типа предполагает, что оно всегда есть; не предупреждай об возможной ошибке для таких полей.
      - ОПЦИОНАЛЬНЫЕ (prop?: Type): доступ без проверки — стилистический риск, но НЕ ошибка «свойство не загружено». Такую проблему НЕ сообщай.
      - ВЛОЖЕННЫЕ СВОЙСТВА (например order.delivery.address): это правило НЕ касается вложенных частей объекта, которые могут быть не загружены в БД (relations, вложенные сущности). Для вложенных свойств проверку «загружено ли в запросе» делай как раньше: если relation/вложенный объект не подгружен в relations/include/select — сообщай проблему, даже если во вложенном типе поле объявлено обязательным.
      - ВНЕШНИЕ ТИПЫ (node_modules): если тип объекта или свойство объявлено типом из внешней библиотеки (импорт из node_modules или путь/спецификатор содержит node_modules), пропусти проверку этого объекта — не сообщай проблемы для его свойств.
      - Итог: обязательное в типе (без ?) на верхнем уровне — не сообщай; вложенные свойства (могут не подгружаться из БД) — проверяй; типы из node_modules — не проверяй.
      
      КОД СЧИТАЕТСЯ БЕЗОПАСНЫМ — НЕ СООБЩАЙ ПРОБЛЕМУ, ЕСЛИ ВИДИШЬ:
      - В строке использования есть optional chaining (?.), nullish coalescing (??), деструктуризация с умолчанием или явная проверка на undefined/null — тогда доступ уже защищён.
      - Объект загружен с нужными полями в любом из связанных файлов или в callSites (relationPaths покрывают propertyPath).
      - Свойство в типе объекта объявлено как опциональное (prop?: Type).
      - Свойство объявлено как обязательное (prop: Type, без ?) на верхнем уровне объекта — не предупреждай об возможной ошибке.
      - Тип объекта или свойство объявлено типом из node_modules — проверку для этого объекта не делай.
      Для ВЛОЖЕННЫХ свойств (цепочка через relation/вложенный объект из БД): если загрузки нет в relations/include/select и в коде обращение без ?./??/проверки — сообщи проблему (риск runtime-ошибки).
      
      ОСОБЫЕ ПРАВИЛА ДЛЯ ORM:
      - relations/include/select/join = загрузка. Загружено в верхней функции или в callSite — считай, что объект пришёл уже с полем.
      - Сообщай проблему только если проследил по всей цепочке: ни в одном callSite, ни в sourceFile, ни в других связанных файлах propertyPath не загружается.
      
      TRACEABILITY (JSON):
      {traceability}
      
      ГЛАВНЫЕ ФАЙЛЫ (источники данных), JSON-массив объектов с полями "file", "content":
      {sourceFiles}
      
      ФАЙЛЫ ИСПОЛЬЗОВАНИЯ И ФАЙЛЫ С ТИПАМИ (все вместе), JSON-массив объектов с полями "file", "content":
      сюда входят код использования и файлы, импортируемые из главных и из использования (в т.ч. только типы: import type). Типы и интерфейсы могут быть в любом из этих файлов — смотри interface/type в них, чтобы определить обязательное (prop: Type) или опциональное (prop?: Type) свойство.
      {usageFiles}
      
      Формат ответа — JSON-массив. Каждый элемент ОБЯЗАТЕЛЬНО содержит: file, line, message, sourceFile, sourceLine, propertyPath.
      sourceFile — файл, где объект загружается/создаётся (или откуда передаётся в вызове). sourceLine — строка в нём (1-based). propertyPath — цепочка свойств (например order.delivery.address).
      КРИТИЧНО для поля line: указывай СТРОГО номер строки из propertyAccessEntries, где в коде обращаются к свойству (доступ к полю, .map с использованием свойства и т.п.). НЕ указывай строку с find/findOne, if (!...), закрывающими скобками или вызовом sendTelegramAdminMessage — иначе сниппет кода будет не по теме проблемы.
      Если не можешь указать sourceFile и propertyPath для проблемы — не включай её в массив.
      [
        {{ "file": "путь/файла_использования", "line": номер_строки, "message": "краткое описание по-русски", "sourceFile": "путь/файла_источника", "sourceLine": номер_строки_источника, "propertyPath": "цепочка.свойств" }}
      ]
      ИТОГ: Пиши ТОЛЬКО по-русски в message. Выведи ТОЛЬКО JSON-массив без Markdown и текста вне JSON.
    `);
      
    this.pushSummaryPrompt = PromptTemplate.fromTemplate(`
      Ты — ведущий разработчик TypeScript/Node.js.
      
      Тебе даны:
      - список git-коммитов (сообщения и затронутые файлы);
      - список критических проблем в коде (только error/security: type, message, impact, suggestion);
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
      Если в "Проблемы" передан непустой массив — обязательно упомяни хотя бы одну-две проблемы (файл, суть). Фразу «критичных проблем не обнаружено» пиши только если массив проблем действительно пуст.
      
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

    /**
     * ВАЖНО для unified-анализатора: мы нумеруем строки исходного файла сами,
     * чтобы модель могла надёжно вернуть корректный номер строки.
     */

    this.unifiedAnalysisPrompt = PromptTemplate.fromTemplate(`
      Ты — Senior-разработчик, проводишь код-ревью изменений в TypeScript/Node.js проекте.
      
      Тебе передан список изменённых файлов с содержимым (newContent) и диффом (diff).
      Изменения (JSON-массив объектов с полями "file", "newContent", "diff"):
      {changes}
      
      ВАЖНО: поле "newContent" уже содержит пронумерованные строки исходного файла в формате "N: код_строки", где N — номер строки, начиная с 1. Когда возвращаешь поле "line" в ответе — используй ИМЕННО этот номер N из префикса "N:". Не придумывай номера строк сам, всегда опирайся на префикс.
      
      Задача: найди только те проблемы, которые гарантированно приведут к ошибке в рантайме, падению или уязвимости. Не сообщай warning/info, стилистику, догадки.
      Проверь:
      - Безопасность: eval, небезопасные вызовы (execSync), XSS-риски (.innerHTML и т.п.).
      - Загрузка данных: обращение к полям/связям объектов, которые не загружаются в запросе (relations, include, select) — только если это приведёт к ошибке в рантайме. (1) Свойство в типе обязательное (без ?) — не сообщай. (2) Вложенные свойства (relation.field), не загруженные в БД — сообщай. (3) Типы из node_modules не проверяй.
      - Контракты: изменение схем сущностей или сигнатур без обновления вызывающего кода — только если вызов сломается в рантайме.
      
      Цепочка вызовов для "line": если проблема — отсутствующая relation в findOne/find, то "line" должна указывать на строку, где используется именно РЕЗУЛЬТАТ ЭТОГО запроса (по цепочке вызовов). Например: findOne в методе A → A вызывает B(transaction) → в B обращаются к transaction.order.positions[].item.translations. Указывай строку в B (где реально произойдёт ошибка), а не похожий код в другом методе C, который получает order из параметра/другого источника. Одна и та же сущность может использоваться в разных методах — важен тот метод, куда передаётся результат данного find.
      
      Верни JSON-массив проблем СТРОГО в формате (только severity "error" — warning и info не используем):
      [
        {{ "file": "путь/к/файлу", "line": number, "severity": "error", "message": "описание", "rule": "краткий_идентификатор", "suggestion": "как исправить" }}
      ]
      Пиши message и suggestion по-русски. rule — латиницей (например security-eval, data-loading-relation).
      Если критических проблем нет — верни пустой массив [].
      Выведи ТОЛЬКО JSON-массив, без markdown и лишнего текста.
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

    // Векторный поиск только для ограниченного числа issue, чтобы не перегружать пайплайн.
    const projectPatterns: { file: string; score: number; snippet: string; }[][] = [];
    const issuesToEnrich = Math.min(issues.length, AIService.MAX_ISSUES_FOR_VECTOR_SEARCH);

    for (let issueIndex = 0; issueIndex < issuesToEnrich; issueIndex += 1) {
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

    for (let index = issuesToEnrich; index < issues.length; index += 1) {
      projectPatterns.push([]);
    }

    const result = await chain.invoke({
      issues: JSON.stringify(issues),
      projectPatterns: JSON.stringify(projectPatterns),
    });

    this.loggerService.debug(
      this.TAG,
      'AI codeReviewPrompt raw response',
      typeof result === 'string' ? result.slice(0, 2000) : result,
    );

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
   * Единый AI-анализ изменений: один запрос к модели с контекстом изменённых файлов.
   * Возвращает список проблем (безопасность, производительность, загрузка данных, контракты).
   * Включать через USE_UNIFIED_AI_ANALYSIS=true как альтернативу getLogicalDataLoadingIssues.
   */
  public getUnifiedAnalysisIssues = async (
    changes: ScmChangeInterface[],
  ): Promise<CodeIssueInterface[]> => {
    if (!changes.length) {
      return [];
    }

    let totalChars = 0;
    const payload: Array<{ file: string; newContent: string; diff: string }> = [];
    const maxPerFile = Math.floor(AIService.UNIFIED_ANALYSIS_MAX_CHARS / Math.max(changes.length, 1));

    for (const change of changes) {
      if (totalChars >= AIService.UNIFIED_ANALYSIS_MAX_CHARS) {
        break;
      }
      const originalContent = change.newContent ?? '';
      if (!originalContent.trim()) {
        continue;
      }
      const newContent = this.buildNumberedContent(originalContent, maxPerFile);
      const diffMaxLen = Math.max(0, maxPerFile - newContent.length);
      const diff = (change.diff ?? '').slice(0, Math.min(2000, diffMaxLen));
      const slice = newContent.length + diff.length;
      if (slice === 0) {
        continue;
      }
      totalChars += slice;
      payload.push({
        file: change.file,
        newContent,
        diff,
      });
    }

    if (!payload.length) {
      return [];
    }

    const llm = await this.getLlm();
    const chain = RunnableSequence.from([
      this.unifiedAnalysisPrompt,
      llm,
      new StringOutputParser(),
    ]);

    const result = await chain.invoke({
      changes: JSON.stringify(payload),
    });

    this.loggerService.debug(
      this.TAG,
      'AI unifiedAnalysisPrompt raw response',
      typeof result === 'string' ? result.slice(0, 2000) : result,
    );

    try {
      const jsonText = this.extractJsonPayload(result);
      const parsed = JSON.parse(jsonText) as unknown;
      if (!Array.isArray(parsed)) {
        return [];
      }
      const mapped = parsed
        .filter(
          (item): item is { file: string; line: unknown; severity: string; message: string; rule?: string; suggestion?: string } =>
            typeof item === 'object' &&
            item !== null &&
            'file' in item &&
            'line' in item &&
            'severity' in item &&
            'message' in item,
        )
        .map((item) => ({
          file: item.file,
          line: this.normalizeLineNumberOneBased(item.line),
          severity: (['error', 'warning', 'info'].includes(item.severity) ? item.severity : 'info') as CodeIssueInterface['severity'],
          message: item.message,
          rule: typeof item.rule === 'string' ? item.rule : 'unified-ai',
          suggestion: typeof item.suggestion === 'string' ? item.suggestion : undefined,
        }));

      this.loggerService.debug(
        this.TAG,
        'AI unifiedAnalysisIssues mapped',
        mapped.slice(0, 20),
      );
      return mapped.filter((issue) => issue.severity === 'error');
    } catch {
      return [];
    }
  };

  /**
   * Логический анализ загрузки данных: модель проверяет безопасное извлечение свойств из объекта.
   * Если свойство загружено в запросе — ошибки не должно быть.
   * Если свойство передано параметром — собираются файлы-вызыватели и проверяется, что там свойство загружено или определено.
   * В контекст передаются главные файлы (источники данных) и файлы использования (в т.ч. места вызова).
   */
  public getLogicalDataLoadingIssues = async (
    changes: ScmChangeInterface[],
    optionsOrGetFileContent?: GetFileContentFn | LogicalDataLoadingOptions,
  ): Promise<CodeIssueInterface[]> => {
    const options: LogicalDataLoadingOptions =
      typeof optionsOrGetFileContent === 'function'
        ? { getFileContent: optionsOrGetFileContent }
        : optionsOrGetFileContent ?? {};
    const getFileContent = options.getFileContent;
    const getSourceFilePaths = options.getSourceFilePaths;

    const allowedExtensions = ['.ts', '.tsx'];
    const sourceFilesPayload: { file: string; content: string; }[] = [];
    const usageFilesPayload: { file: string; content: string; }[] = [];
    const seenPaths = new Set<string>();
    let totalChars = 0;
    const changedPathsNormalized = new Set<string>();
    const parameterPropertyAccessTargets = this.collectParameterPropertyAccessTargetsFromChanges(changes);
    let traceabilityPayload: TraceabilityPayloadItem[] = [];
    let callSiteFilesByTargetKey = new Map<string, Set<string>>();
    let callSitesByTargetKey = new Map<string, CallSiteTraceInfo[]>();

    const maxTotalChars = AIService.LOGICAL_DATA_LOADING_MAX_CHARS;
    const maxCharsPerFile = AIService.LOGICAL_DATA_LOADING_MAX_CHARS_PER_FILE;
    const reservedForUsage = Math.floor(maxTotalChars / 2);

    for (const change of changes) {
      const extension = change.file.slice(change.file.lastIndexOf('.')).toLowerCase();
      if (!allowedExtensions.includes(extension) || !change.newContent?.trim()) {
        continue;
      }
      const content = change.newContent.slice(0, maxCharsPerFile);
      if (totalChars + content.length > maxTotalChars - reservedForUsage) {
        break;
      }
      const normalizedPath = path.normalize(change.file).replace(/\\/g, '/');
      changedPathsNormalized.add(this.normalizePathWithoutExtension(change.file));
      if (!seenPaths.has(normalizedPath)) {
        seenPaths.add(normalizedPath);
        sourceFilesPayload.push({ file: change.file, content });
        totalChars += content.length;
      }
    }

    if (getFileContent && sourceFilesPayload.length > 0) {
      const tsconfigPaths = await this.loadTsconfigPaths(getFileContent);
      const pathResolver = this.buildPathResolver(tsconfigPaths);

      const addUsageFileContent = async (filePath: string): Promise<void> => {
        if (totalChars >= maxTotalChars) {
          return;
        }
        const normalized = path.normalize(filePath).replace(/\\/g, '/');
        if (seenPaths.has(normalized)) {
          return;
        }
        try {
          const content = await getFileContent(filePath);
          if (!content?.trim()) {
            return;
          }
          const slice = content.slice(0, maxCharsPerFile);
          if (totalChars + slice.length <= maxTotalChars) {
            seenPaths.add(normalized);
            usageFilesPayload.push({ file: filePath, content: slice });
            totalChars += slice.length;
          }
        } catch {
          // ignore
        }
      };

      const callSiteCollectionResult = getSourceFilePaths && parameterPropertyAccessTargets.length > 0
        ? await this.collectCallSiteFilePaths(
          parameterPropertyAccessTargets,
          getSourceFilePaths,
          getFileContent,
        )
        : null;

      if (callSiteCollectionResult) {
        callSiteFilesByTargetKey = callSiteCollectionResult.callSiteFilesByTargetKey;
        callSitesByTargetKey = callSiteCollectionResult.callSitesByTargetKey;
        for (const callSitePath of callSiteCollectionResult.callSiteFiles) {
          await addUsageFileContent(callSitePath);
          if (totalChars >= maxTotalChars) {
            break;
          }
        }
      }

      const importedPaths = this.collectImportedPathsFromChanges(changes, pathResolver);
      const resolvedImportExtensions = ['.ts', '.tsx', '.d.ts'];
      for (const resolvedPathBase of importedPaths) {
        if (totalChars >= maxTotalChars) {
          break;
        }
        if (resolvedPathBase.includes('node_modules')) {
          continue;
        }
        let content: string | null = null;
        let resolvedWithExt = '';
        for (const ext of resolvedImportExtensions) {
          const candidate = resolvedPathBase + ext;
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
          const slice = content.slice(0, maxCharsPerFile);
          if (totalChars + slice.length <= maxTotalChars) {
            seenPaths.add(path.normalize(resolvedWithExt).replace(/\\/g, '/'));
            usageFilesPayload.push({ file: resolvedWithExt, content: slice });
            totalChars += slice.length;
          }
        }
      }

      const addTypeDefinitionFileContent = async (filePath: string): Promise<void> => {
        if (totalChars >= maxTotalChars) {
          return;
        }
        const normalized = path.normalize(filePath).replace(/\\/g, '/');
        if (seenPaths.has(normalized)) {
          return;
        }
        try {
          const content = await getFileContent(filePath);
          if (!content?.trim()) {
            return;
          }
          const slice = content.slice(0, maxCharsPerFile);
          if (totalChars + slice.length <= maxTotalChars) {
            seenPaths.add(normalized);
            usageFilesPayload.push({ file: filePath, content: slice });
            totalChars += slice.length;
          }
        } catch {
          // ignore
        }
      };

      const allFilesForImportScan = [...sourceFilesPayload, ...usageFilesPayload];
      const secondLevelImportPaths = this.collectImportedPathsFromFiles(allFilesForImportScan, pathResolver);
      for (const resolvedPathBase of secondLevelImportPaths) {
        if (totalChars >= maxTotalChars) {
          break;
        }
        if (resolvedPathBase.includes('node_modules')) {
          continue;
        }
        for (const ext of resolvedImportExtensions) {
          const candidate = resolvedPathBase + ext;
          const normalized = path.normalize(candidate).replace(/\\/g, '/');
          if (seenPaths.has(normalized)) {
            break;
          }
          try {
            await addTypeDefinitionFileContent(candidate);
            break;
          } catch {
            continue;
          }
        }
      }

      if (getSourceFilePaths && changedPathsNormalized.size > 0) {
        const callerPaths = await this.collectCallerFilePaths(
          Array.from(changedPathsNormalized),
          getSourceFilePaths,
          getFileContent,
          pathResolver,
        );
        for (const callerPath of callerPaths) {
          await addUsageFileContent(callerPath);
        }
      }
    }

    traceabilityPayload = this.buildTraceabilityPayload(
      parameterPropertyAccessTargets,
      callSiteFilesByTargetKey,
      callSitesByTargetKey,
    );
    const staticIssues = this.buildStaticRelationIssues(
      parameterPropertyAccessTargets,
      callSitesByTargetKey,
    );

    const hasAnyFiles = sourceFilesPayload.length > 0 || usageFilesPayload.length > 0;
    if (!hasAnyFiles) {
      return staticIssues;
    }

    const llm = await this.getLlm();
    const chain = RunnableSequence.from([
      this.logicalDataLoadingPrompt,
      llm,
      new StringOutputParser(),
    ]);

    const result = await chain.invoke({
      sourceFiles: JSON.stringify(sourceFilesPayload),
      usageFiles: JSON.stringify(usageFilesPayload),
      traceability: JSON.stringify(traceabilityPayload),
    });

    this.loggerService.debug(
      this.TAG,
      'AI logicalDataLoadingPrompt raw response',
      typeof result === 'string' ? result.slice(0, 2000) : result,
    );

    const sourcePathsSet = new Set(
      sourceFilesPayload.map((payload) => path.normalize(payload.file).replace(/\\/g, '/')),
    );
    const usagePathsSet = new Set(
      usageFilesPayload.map((payload) => path.normalize(payload.file).replace(/\\/g, '/')),
    );
    const allKnownPathsSet = new Set([...sourcePathsSet, ...usagePathsSet]);

    let items: Array<{ file: string; line: number; message: string; sourceFile: string; sourceLine: number; propertyPath: string }> = [];

    try {
      const jsonText = this.extractJsonPayload(result);
      const parsed = JSON.parse(jsonText) as unknown;
      if (Array.isArray(parsed)) {
        items = parsed
          .filter(
            (item): item is { file: string; line: unknown; message: string; sourceFile: unknown; sourceLine: unknown; propertyPath: unknown } =>
              typeof item === 'object' &&
              item !== null &&
              'file' in item &&
              'line' in item &&
              'message' in item &&
              'sourceFile' in item &&
              item.sourceFile != null &&
              String(item.sourceFile).trim() !== '' &&
              'propertyPath' in item &&
              item.propertyPath != null &&
              String(item.propertyPath).trim() !== '',
          )
          .map((item) => ({
            file: String(item.file),
            line: this.normalizeLineNumberOneBased(item.line),
            message: String(item.message),
            sourceFile: String(item.sourceFile).trim(),
            sourceLine: this.normalizeLineNumberOneBased(item.sourceLine),
            propertyPath: String(item.propertyPath).trim(),
          }))
          .filter((item) => {
            const usageNorm = path.normalize(item.file).replace(/\\/g, '/');
            const sourceNorm = path.normalize(item.sourceFile).replace(/\\/g, '/');
            return allKnownPathsSet.has(sourceNorm) && (usagePathsSet.has(usageNorm) || sourcePathsSet.has(usageNorm));
          });

        this.loggerService.debug(
          this.TAG,
          'AI logicalDataLoadingPrompt parsed items',
          items.slice(0, 20),
        );
      }
    } catch {
      return [];
    }

    const contentByFile = this.buildFileContentMap(sourceFilesPayload, usageFilesPayload);
    const itemsWithCorrectLine = items.map((item) => ({
      ...item,
      line: this.resolveLineFromTraceability(traceabilityPayload, item.file, item.propertyPath, item.line),
    }));
    let filteredItems = itemsWithCorrectLine.filter((item) =>
      this.isLineWithPropertyAccess(item.file, item.line, contentByFile),
    );
    // Ложное срабатывание: связь подгружается в любом из связанных файлов (в т.ч. в верхней/вызывающей функции).
    filteredItems = filteredItems.filter((item) =>
      !this.isFalsePositiveRelationInAnyRelatedFile(item.message, contentByFile),
    );
    // Убираем только срабатывания, где доступ уже безопасен (?. или ??). Небезопасный доступ оставляем в отчёте.
    filteredItems = filteredItems.filter((item) =>
      !this.lineHasSafeAccessPattern(item.file, item.line, contentByFile),
    );

    const llmIssues = filteredItems.map((item) => {
      const traceSuffix = ` [источник: ${item.sourceFile}:${item.sourceLine}, свойство: ${item.propertyPath}]`;
      const messageWithTrace = item.message.includes(item.sourceFile) || item.message.includes(item.propertyPath)
        ? item.message
        : `${item.message}${traceSuffix}`;
      return {
        file: item.file,
        line: item.line,
        severity: 'error' as const,
        message: messageWithTrace,
        rule: 'logical-query-result-mismatch',
      };
    });
    const mergedIssues: CodeIssueInterface[] = [...llmIssues, ...staticIssues];
    const seenIssueKeys = new Set<string>();
    const uniqueIssues: CodeIssueInterface[] = [];
    for (const issue of mergedIssues) {
      const issueKey = `${issue.file}:${issue.line}:${issue.message}`;
      if (seenIssueKeys.has(issueKey)) {
        continue;
      }
      seenIssueKeys.add(issueKey);
      uniqueIssues.push(issue);
    }

    return uniqueIssues.filter((issue) => issue.severity === 'error');
  };

  /**
   * Краткое человеческое описание того, что изменил push,
   * с учётом коммитов, diff'ов и найденных проблем/рекомендаций.
   * При большом объёме изменений отправляет несколько запросов по батчам и объединяет результат.
   */
  public summarizePush = async (
    commits: PushCommitSummaryInput[],
    recommendations: AICodeIssueRecommendation[],
    changes: ScmChangeInterface[],
  ): Promise<string> => {
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

  /** Нормализует путь и убирает расширение для сравнения. */
  private normalizePathWithoutExtension = (filePath: string): string =>
    path.normalize(filePath).replace(/\\/g, '/').replace(/\.(tsx?|jsx?)$/i, '');

  private buildFileContentMap = (
    sourceFiles: Array<{ file: string; content: string }>,
    usageFiles: Array<{ file: string; content: string }>,
  ): Map<string, string> => {
    const map = new Map<string, string>();
    const add = (entry: { file: string; content: string }) => {
      const key = path.normalize(entry.file).replace(/\\/g, '/');
      map.set(key, entry.content);
    };
    sourceFiles.forEach(add);
    usageFiles.forEach(add);
    return map;
  };

  /** Нормализует номер строки из ответа модели: ожидается 1-based, первая строка = 1. */
  private normalizeLineNumberOneBased = (value: unknown): number => {
    const numberValue = Math.floor(Number(value));
    if (!Number.isFinite(numberValue) || numberValue < 1) {
      return 1;
    }
    return numberValue;
  };

  /**
   * Строка содержит безопасный доступ: optional chaining (?.) или nullish coalescing (??) —
   * такие срабатывания отфильтровываем как ложные (доступ уже безопасен).
   */
  private lineHasSafeAccessPattern = (
    filePath: string,
    lineOneBased: number,
    contentByFile: Map<string, string>,
  ): boolean => {
    const content = contentByFile.get(path.normalize(filePath).replace(/\\/g, '/'));
    if (!content) {
      return false;
    }
    const lines = content.split('\n');
    const lineIndex = lineOneBased - 1;
    if (lineIndex < 0 || lineIndex >= lines.length) {
      return false;
    }
    const line = lines[lineIndex];
    return /\?\./.test(line) || /\?\?/.test(line);
  };

  /**
   * Если в сообщении говорится о «незагруженной связи», но в любом из связанных файлов
   * (в т.ч. в верхней/вызывающей функции) эта связь есть в relations/join/include —
   * считаем срабатывание ложным и отфильтровываем.
   */
  private isFalsePositiveRelationInAnyRelatedFile = (
    message: string,
    contentByFile: Map<string, string>,
  ): boolean => {
    const relationKey = this.extractRelationKeyFromMessage(message);
    if (!relationKey) {
      return false;
    }
    for (const content of contentByFile.values()) {
      if (this.fileContainsRelationInQuery(content, relationKey)) {
        return true;
      }
    }
    return false;
  };

  /** Извлекает ключ связи из текста сообщения (например "order.delivery"). */
  private extractRelationKeyFromMessage = (message: string): string | null => {
    const withQuotes = message.match(/связи\s+['"]([^'"]+)['"]/i);
    if (withQuotes?.[1]) {
      const relation = withQuotes[1].trim();
      if (relation.includes('.')) {
        return relation;
      }
      const entityMatch = message.match(/сущности\s+(\w+)/i);
      if (entityMatch?.[1]) {
        return `${entityMatch[1].trim()}.${relation}`;
      }
      return relation;
    }
    const dotted = message.match(/(\w+(?:\.\w+)+)/g);
    if (dotted?.length) {
      const candidate = dotted.find((part) => /\.\w+$/.test(part) && message.includes(part));
      return candidate ?? dotted[0] ?? null;
    }
    return null;
  };

  /** Проверяет, что в содержимом файла связь указана в relations/join (findOne, find, leftJoinAndSelect и т.д.). */
  private fileContainsRelationInQuery = (content: string, relationKey: string): boolean => {
    const quoted = content.includes(`'${relationKey}'`) || content.includes(`"${relationKey}"`);
    if (!quoted) {
      return false;
    }
    const hasFind = /\b(?:findOne|find)\s*\(\s*\{[\s\S]*?relations\s*:/i.test(content)
      || /\b(?:leftJoinAndSelect|innerJoinAndSelect)\s*\(/i.test(content)
      || /\b(?:include|select)\s*:\s*\{/i.test(content);
    return hasFind;
  };

  /**
   * Подставляет номер строки из traceability (AST), чтобы сниппет показывал место обращения к свойству,
   * а не произвольную строку из ответа LLM.
   */
  private resolveLineFromTraceability = (
    traceabilityPayload: TraceabilityPayloadItem[],
    usageFile: string,
    propertyPath: string,
    fallbackLine: number,
  ): number => {
    const normalizedUsage = path.normalize(usageFile).replace(/\\/g, '/');
    const propertyPathTrimmed = propertyPath.trim();
    const lastSegment = propertyPathTrimmed.split('.').filter(Boolean).pop() ?? '';

    for (const item of traceabilityPayload) {
      const normalizedDefinition = path.normalize(item.definitionFile).replace(/\\/g, '/');
      if (normalizedDefinition !== normalizedUsage) {
        continue;
      }
      for (const entry of item.propertyAccessEntries) {
        if (entry.propertyPath === propertyPathTrimmed) {
          return entry.line;
        }
        const entryLast = entry.propertyPath.split('.').filter(Boolean).pop();
        if (lastSegment && entryLast === lastSegment) {
          return entry.line;
        }
      }
    }
    return fallbackLine;
  };

  /** Проверяет, что в указанной строке файла есть обращение к свойству (например obj.prop или obj?.prop). */
  private isLineWithPropertyAccess = (
    filePath: string,
    lineOneBased: number,
    contentByFile: Map<string, string>,
  ): boolean => {
    const content = contentByFile.get(path.normalize(filePath).replace(/\\/g, '/'));
    if (!content) {
      return true;
    }
    const lines = content.split('\n');
    const lineIndex = lineOneBased - 1;
    if (lineIndex < 0 || lineIndex >= lines.length) {
      return false;
    }
    const line = lines[lineIndex];
    return AIService.PROPERTY_ACCESS_LINE_PATTERN.test(line);
  };

  private buildNumberedContent = (content: string, maxCharsPerFile: number): string => {
    const lines = content.split('\n');
    const numberedLines: string[] = [];
    let totalLength = 0;

    for (let index = 0; index < lines.length; index += 1) {
      const lineNumber = index + 1;
      const numberedLine = `${lineNumber}: ${lines[index]}`;
      const nextLength = totalLength + numberedLine.length + 1;

      if (nextLength > maxCharsPerFile) {
        break;
      }

      numberedLines.push(numberedLine);
      totalLength = nextLength;
    }

    return numberedLines.join('\n');
  };

  /**
   * Собирает пути файлов, которые импортируют хотя бы один из изменённых файлов (места вызова).
   */
  private collectCallerFilePaths = async (
    changedPathsWithoutExtension: string[],
    getSourceFilePaths: () => Promise<string[]>,
    getFileContent: GetFileContentFn,
    pathResolver: (specifier: string, fromFile: string) => string | null,
  ): Promise<string[]> => {
    const changedSet = new Set(
      changedPathsWithoutExtension.map((pathItem) => path.normalize(pathItem).replace(/\\/g, '/')),
    );
    const sourcePaths = await getSourceFilePaths();
    const callerPaths: string[] = [];
    const allowedExtensions = ['.ts', '.tsx'];

    for (const fromPath of sourcePaths) {
      const extension = fromPath.slice(fromPath.lastIndexOf('.')).toLowerCase();
      if (!allowedExtensions.includes(extension)) {
        continue;
      }
      let content: string;
      try {
        content = await getFileContent(fromPath);
      } catch {
        continue;
      }
      if (!content?.trim()) {
        continue;
      }
      const sourceFile = ts.createSourceFile(
        fromPath,
        content,
        ts.ScriptTarget.Latest,
        true,
      );
      const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
          const specifier = node.moduleSpecifier.text;
          if (specifier.includes('node_modules') || specifier.includes('README.md') || (specifier.length > 0 && !specifier.startsWith('.') && !specifier.startsWith('@') && !specifier.includes('/'))) {
            return;
          }
          const resolved = pathResolver(specifier, fromPath);
          if (resolved) {
            const resolvedNormalized = this.normalizePathWithoutExtension(resolved);
            if (changedSet.has(resolvedNormalized)) {
              callerPaths.push(fromPath);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }

    return [...new Set(callerPaths)];
  };

  /** Собирает пути файлов, импортируемых из изменённых (относительные и алиасы), без расширения. */
  private collectImportedPathsFromChanges = (
    changes: ScmChangeInterface[],
    pathResolver: (specifier: string, fromFile: string) => string | null,
  ): string[] => {
    const payload = changes
      .filter((change) => {
        const extension = change.file.slice(change.file.lastIndexOf('.')).toLowerCase();
        return (extension === '.ts' || extension === '.tsx') && Boolean(change.newContent?.trim());
      })
      .map((change) => ({ file: change.file, content: change.newContent }));
    return this.collectImportedPathsFromFiles(payload, pathResolver);
  };

  /** Собирает пути файлов, импортируемых из переданных файлов (относительные и алиасы), без расширения. */
  private collectImportedPathsFromFiles = (
    files: Array<{ file: string; content: string }>,
    pathResolver: (specifier: string, fromFile: string) => string | null,
  ): string[] => {
    const resultSet = new Set<string>();

    for (const fileItem of files) {
      const sourceFile = ts.createSourceFile(
        fileItem.file,
        fileItem.content,
        ts.ScriptTarget.Latest,
        true,
      );

      const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
          const specifier = node.moduleSpecifier.text;
          if (specifier.includes('node_modules') || specifier.includes('README.md') || (specifier.length > 0 && !specifier.startsWith('.') && !specifier.startsWith('@') && !specifier.includes('/'))) {
            return;
          }
          const resolved = pathResolver(specifier, fileItem.file);
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

  private buildParameterPropertyAccessTargetKey = (target: {
    filePath: string;
    kind: ParameterPropertyAccessTarget['kind'];
    name: string;
    className?: string;
  }): string => {
    const normalizedFilePath = path.normalize(target.filePath).replace(/\\/g, '/');
    const classNamePart = target.className ? `:${target.className}` : '';
    return `${normalizedFilePath}:${target.kind}:${target.name}${classNamePart}`;
  };

  private mergeUniqueStrings = (currentValues: string[], nextValues: string[]): string[] => {
    const mergedSet = new Set<string>();
    for (const value of currentValues) {
      if (value?.trim()) {
        mergedSet.add(value);
      }
    }
    for (const value of nextValues) {
      if (value?.trim()) {
        mergedSet.add(value);
      }
    }
    return Array.from(mergedSet);
  };

  private mergePropertyAccessEntries = (
    currentEntries: ParameterPropertyAccessEntry[],
    nextEntries: ParameterPropertyAccessEntry[],
  ): ParameterPropertyAccessEntry[] => {
    const mergedEntries: ParameterPropertyAccessEntry[] = [];
    const seenKeys = new Set<string>();

    const addEntry = (entry: ParameterPropertyAccessEntry): void => {
      const key = `${entry.parameterIndex}:${entry.propertyPath}:${entry.requiresExactRelation}:${entry.line}`;
      if (seenKeys.has(key)) {
        return;
      }
      seenKeys.add(key);
      mergedEntries.push(entry);
    };

    currentEntries.forEach(addEntry);
    nextEntries.forEach(addEntry);

    return mergedEntries;
  };

  private collectParameterPropertyAccessTargetsFromChanges = (changes: ScmChangeInterface[]): ParameterPropertyAccessTarget[] => {
    const allowedExtensions = ['.ts', '.tsx'];
    const targetsByKey = new Map<string, ParameterPropertyAccessTarget>();

    for (const change of changes) {
      const extension = change.file.slice(change.file.lastIndexOf('.')).toLowerCase();
      if (!allowedExtensions.includes(extension) || !change.newContent?.trim()) {
        continue;
      }
      const targets = this.collectParameterPropertyAccessTargetsFromFile(change.file, change.newContent);
      for (const target of targets) {
        const existingTarget = targetsByKey.get(target.key);
        if (!existingTarget) {
          targetsByKey.set(target.key, target);
          continue;
        }
        existingTarget.parameterNames = this.mergeUniqueStrings(
          existingTarget.parameterNames,
          target.parameterNames,
        );
        existingTarget.destructuredProperties = this.mergeUniqueStrings(
          existingTarget.destructuredProperties,
          target.destructuredProperties,
        );
        existingTarget.propertyAccesses = this.mergeUniqueStrings(
          existingTarget.propertyAccesses,
          target.propertyAccesses,
        );
        existingTarget.propertyAccessEntries = this.mergePropertyAccessEntries(
          existingTarget.propertyAccessEntries,
          target.propertyAccessEntries,
        );
      }
    }

    return Array.from(targetsByKey.values());
  };

  private collectParameterPropertyAccessTargetsFromFile = (
    filePath: string,
    content: string,
  ): ParameterPropertyAccessTarget[] => {
    const sourceFile = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      true,
    );
    const targetsByKey = new Map<string, ParameterPropertyAccessTarget>();

    type ParameterAlias = { parameterIndex: number; pathSegments: string[] };

    const arrayMethodNames = new Set<string>([
      'map',
      'filter',
      'find',
      'findIndex',
      'findLast',
      'findLastIndex',
      'forEach',
      'reduce',
      'reduceRight',
      'some',
      'every',
      'flatMap',
    ]);

    const getLineNumberFromNode = (node: ts.Node): number => {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      return line + 1;
    };

    const cloneAliasMap = (aliasMap: Map<string, ParameterAlias>): Map<string, ParameterAlias> => {
      return new Map(
        Array.from(aliasMap.entries()).map(([key, value]) => [
          key,
          { parameterIndex: value.parameterIndex, pathSegments: [...value.pathSegments] },
        ]),
      );
    };

    const unwrapExpression = (expression: ts.Expression): ts.Expression => {
      if (ts.isParenthesizedExpression(expression)) {
        return unwrapExpression(expression.expression);
      }
      if (ts.isAwaitExpression(expression)) {
        return unwrapExpression(expression.expression);
      }
      if (ts.isNonNullExpression(expression)) {
        return unwrapExpression(expression.expression);
      }
      if (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) {
        return unwrapExpression(expression.expression);
      }
      return expression;
    };

    const extractExpressionSegments = (
      expression: ts.Expression,
    ): { baseName: string | null; segments: string[] } => {
      const unwrappedExpression = unwrapExpression(expression);
      if (ts.isIdentifier(unwrappedExpression)) {
        return { baseName: unwrappedExpression.text, segments: [] };
      }
      if (ts.isPropertyAccessExpression(unwrappedExpression) || ts.isPropertyAccessChain(unwrappedExpression)) {
        const parentResult = extractExpressionSegments(unwrappedExpression.expression);
        if (!parentResult.baseName) {
          return { baseName: null, segments: [] };
        }
        return {
          baseName: parentResult.baseName,
          segments: [...parentResult.segments, unwrappedExpression.name.text],
        };
      }
      if (ts.isElementAccessExpression(unwrappedExpression)) {
        const parentResult = extractExpressionSegments(unwrappedExpression.expression);
        if (!parentResult.baseName) {
          return { baseName: null, segments: [] };
        }
        if (ts.isStringLiteral(unwrappedExpression.argumentExpression) || ts.isNumericLiteral(unwrappedExpression.argumentExpression)) {
          return {
            baseName: parentResult.baseName,
            segments: [...parentResult.segments, unwrappedExpression.argumentExpression.text],
          };
        }
      }
      return { baseName: null, segments: [] };
    };

    const resolveExpressionToAlias = (
      expression: ts.Expression,
      aliasMap: Map<string, ParameterAlias>,
    ): { alias: ParameterAlias; propertySegments: string[] } | null => {
      const result = extractExpressionSegments(expression);
      if (!result.baseName) {
        return null;
      }
      const alias = aliasMap.get(result.baseName);
      if (!alias) {
        return null;
      }
      return { alias, propertySegments: result.segments };
    };

    const addBindingAliases = (
      bindingPattern: ts.ObjectBindingPattern,
      baseAlias: ParameterAlias,
      aliasMap: Map<string, ParameterAlias>,
    ): void => {
      for (const element of bindingPattern.elements) {
        if (element.dotDotDotToken) {
          continue;
        }
        const propertyNameNode = element.propertyName ?? element.name;
        if (
          !ts.isIdentifier(propertyNameNode)
          && !ts.isStringLiteral(propertyNameNode)
          && !ts.isNumericLiteral(propertyNameNode)
          && !ts.isComputedPropertyName(propertyNameNode)
        ) {
          continue;
        }
        const propertyName = this.getPropertyNameText(propertyNameNode, sourceFile);
        if (!propertyName) {
          continue;
        }
        const nextAlias: ParameterAlias = {
          parameterIndex: baseAlias.parameterIndex,
          pathSegments: [...baseAlias.pathSegments, propertyName],
        };
        if (ts.isIdentifier(element.name)) {
          aliasMap.set(element.name.text, nextAlias);
        } else if (ts.isObjectBindingPattern(element.name)) {
          addBindingAliases(element.name, nextAlias, aliasMap);
        }
      }
    };

    const collectAliasMapFromParameters = (
      parameters: ts.NodeArray<ts.ParameterDeclaration>,
    ): Map<string, ParameterAlias> => {
      const aliasMap = new Map<string, ParameterAlias>();
      parameters.forEach((parameter, parameterIndex) => {
        if (ts.isIdentifier(parameter.name)) {
          aliasMap.set(parameter.name.text, { parameterIndex, pathSegments: [] });
        } else if (ts.isObjectBindingPattern(parameter.name)) {
          addBindingAliases(parameter.name, { parameterIndex, pathSegments: [] }, aliasMap);
        }
      });
      return aliasMap;
    };

    const applyAliasFromVariableDeclaration = (
      declaration: ts.VariableDeclaration,
      aliasMap: Map<string, ParameterAlias>,
    ): void => {
      if (!declaration.initializer) {
        return;
      }
      const resolved = resolveExpressionToAlias(declaration.initializer, aliasMap);
      if (!resolved) {
        return;
      }
      const nextAlias: ParameterAlias = {
        parameterIndex: resolved.alias.parameterIndex,
        pathSegments: [...resolved.alias.pathSegments, ...resolved.propertySegments],
      };
      if (ts.isIdentifier(declaration.name)) {
        aliasMap.set(declaration.name.text, nextAlias);
      } else if (ts.isObjectBindingPattern(declaration.name)) {
        addBindingAliases(declaration.name, nextAlias, aliasMap);
      }
    };

    const recordPropertyAccessEntry = (
      alias: ParameterAlias,
      propertySegments: string[],
      requiresExactRelation: boolean,
      node: ts.Node,
      entries: ParameterPropertyAccessEntry[],
      entryKeys: Set<string>,
    ): void => {
      const pathSegments = [...alias.pathSegments, ...propertySegments];
      if (pathSegments.length === 0) {
        return;
      }
      const propertyPath = pathSegments.join('.');
      const line = getLineNumberFromNode(node);
      const key = `${alias.parameterIndex}:${propertyPath}:${requiresExactRelation}:${line}`;
      if (entryKeys.has(key)) {
        return;
      }
      entryKeys.add(key);
      entries.push({
        parameterIndex: alias.parameterIndex,
        propertyPath,
        requiresExactRelation,
        line,
      });
    };

    const recordArrayUsageAccess = (
      expression: ts.Expression,
      aliasMap: Map<string, ParameterAlias>,
      entries: ParameterPropertyAccessEntry[],
      entryKeys: Set<string>,
    ): void => {
      const resolved = resolveExpressionToAlias(expression, aliasMap);
      if (!resolved) {
        return;
      }
      recordPropertyAccessEntry(
        resolved.alias,
        resolved.propertySegments,
        true,
        expression,
        entries,
        entryKeys,
      );
    };

    const recordTarget = (target: ParameterPropertyAccessTarget): void => {
      const existingTarget = targetsByKey.get(target.key);
      if (!existingTarget) {
        targetsByKey.set(target.key, target);
        return;
      }
      existingTarget.parameterNames = this.mergeUniqueStrings(
        existingTarget.parameterNames,
        target.parameterNames,
      );
      existingTarget.destructuredProperties = this.mergeUniqueStrings(
        existingTarget.destructuredProperties,
        target.destructuredProperties,
      );
      existingTarget.propertyAccesses = this.mergeUniqueStrings(
        existingTarget.propertyAccesses,
        target.propertyAccesses,
      );
      existingTarget.propertyAccessEntries = this.mergePropertyAccessEntries(
        existingTarget.propertyAccessEntries,
        target.propertyAccessEntries,
      );
    };

    const handleFunctionLike = (
      functionLikeNode: ts.FunctionLikeDeclarationBase,
      functionName: string,
      kind: ParameterPropertyAccessTarget['kind'],
      className?: string,
    ): void => {
      const parameterInfo = this.collectFunctionParameterInfo(functionLikeNode.parameters, sourceFile);
      const parameterNames = parameterInfo.parameterNames;
      const destructuredProperties = parameterInfo.destructuredProperties;
      if (functionLikeNode.parameters.length === 0) {
        return;
      }
      const parameterNamesByIndex = functionLikeNode.parameters.map((parameter, parameterIndex) => {
        if (ts.isIdentifier(parameter.name)) {
          return parameter.name.text;
        }
        return `param${parameterIndex + 1}`;
      });

      const propertyAccessEntries: ParameterPropertyAccessEntry[] = [];
      const propertyAccessEntryKeys = new Set<string>();
      const aliasMap = collectAliasMapFromParameters(functionLikeNode.parameters);

      const visitNode = (node: ts.Node, currentAliasMap: Map<string, ParameterAlias>): void => {
        if (ts.isFunctionLike(node) && node !== functionLikeNode) {
          return;
        }

        if (ts.isVariableDeclaration(node)) {
          applyAliasFromVariableDeclaration(node, currentAliasMap);
        }

        if (ts.isCallExpression(node)) {
          const callExpressionTarget = node.expression;
          if (ts.isPropertyAccessExpression(callExpressionTarget) || ts.isPropertyAccessChain(callExpressionTarget)) {
            const methodName = callExpressionTarget.name.text;
            if (arrayMethodNames.has(methodName)) {
              recordArrayUsageAccess(callExpressionTarget.expression, currentAliasMap, propertyAccessEntries, propertyAccessEntryKeys);
              const callback = node.arguments[0];
              if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
                const resolved = resolveExpressionToAlias(callExpressionTarget.expression, currentAliasMap);
                if (resolved) {
                  const callbackAliasMap = cloneAliasMap(currentAliasMap);
                  const baseAlias: ParameterAlias = {
                    parameterIndex: resolved.alias.parameterIndex,
                    pathSegments: [...resolved.alias.pathSegments, ...resolved.propertySegments],
                  };
                  const callbackParameter = callback.parameters[0];
                  if (callbackParameter) {
                    if (ts.isIdentifier(callbackParameter.name)) {
                      callbackAliasMap.set(callbackParameter.name.text, baseAlias);
                    } else if (ts.isObjectBindingPattern(callbackParameter.name)) {
                      addBindingAliases(callbackParameter.name, baseAlias, callbackAliasMap);
                    }
                  }
                  if (callback.body) {
                    if (ts.isBlock(callback.body)) {
                      callback.body.statements.forEach((statement) => visitNode(statement, callbackAliasMap));
                    } else {
                      visitNode(callback.body, callbackAliasMap);
                    }
                  }
                }
              }
            }
          }
        }

        if (ts.isPropertyAccessExpression(node) || ts.isPropertyAccessChain(node)) {
          const isCallExpressionTarget = ts.isCallExpression(node.parent) && node.parent.expression === node;
          if (!isCallExpressionTarget) {
            if (node.name.text === 'length') {
              recordArrayUsageAccess(node.expression, currentAliasMap, propertyAccessEntries, propertyAccessEntryKeys);
            } else {
              const resolved = resolveExpressionToAlias(node, currentAliasMap);
              if (resolved) {
                recordPropertyAccessEntry(
                  resolved.alias,
                  resolved.propertySegments,
                  false,
                  node,
                  propertyAccessEntries,
                  propertyAccessEntryKeys,
                );
              }
            }
          }
        }

        if (ts.isElementAccessExpression(node)) {
          recordArrayUsageAccess(node.expression, currentAliasMap, propertyAccessEntries, propertyAccessEntryKeys);
        }

        ts.forEachChild(node, (child) => visitNode(child, currentAliasMap));
      };

      if (functionLikeNode.body) {
        visitNode(functionLikeNode.body, aliasMap);
      }

      if (propertyAccessEntries.length === 0 && destructuredProperties.length === 0) {
        return;
      }

      const propertyAccesses = propertyAccessEntries.map((entry) => {
        const parameterName = parameterNamesByIndex[entry.parameterIndex] ?? `param${entry.parameterIndex + 1}`;
        return `${parameterName}.${entry.propertyPath}`;
      });

      const target: ParameterPropertyAccessTarget = {
        key: this.buildParameterPropertyAccessTargetKey({
          filePath,
          kind,
          name: functionName,
          className,
        }),
        kind,
        name: functionName,
        className,
        filePath,
        parameterNames,
        destructuredProperties,
        propertyAccesses,
        propertyAccessEntries,
      };

      recordTarget(target);
    };

    const visitNode = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name) {
        handleFunctionLike(node, node.name.text, 'function');
      }

      if (ts.isVariableStatement(node)) {
        for (const declaration of node.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
            continue;
          }
          if (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)) {
            handleFunctionLike(declaration.initializer, declaration.name.text, 'function');
          }
        }
      }

      if (ts.isClassDeclaration(node) && node.name) {
        const className = node.name.text;
        for (const member of node.members) {
          if (ts.isMethodDeclaration(member) && member.name) {
            const methodName = this.getPropertyNameText(member.name, sourceFile);
            if (methodName) {
              handleFunctionLike(member, methodName, 'method', className);
            }
            continue;
          }
          if (
            ts.isPropertyDeclaration(member)
            && member.name
            && member.initializer
            && (ts.isArrowFunction(member.initializer) || ts.isFunctionExpression(member.initializer))
          ) {
            const methodName = this.getPropertyNameText(member.name, sourceFile);
            if (methodName) {
              handleFunctionLike(member.initializer, methodName, 'method', className);
            }
          }
        }
      }

      ts.forEachChild(node, visitNode);
    };

    visitNode(sourceFile);

    return Array.from(targetsByKey.values());
  };

  private collectFunctionParameterInfo = (
    parameters: ts.NodeArray<ts.ParameterDeclaration>,
    sourceFile: ts.SourceFile,
  ): { parameterNames: string[]; destructuredProperties: string[] } => {
    const parameterNames: string[] = [];
    const destructuredProperties: string[] = [];

    for (const parameter of parameters) {
      const parameterName = parameter.name;
      if (ts.isIdentifier(parameterName)) {
        parameterNames.push(parameterName.text);
        continue;
      }
      if (ts.isObjectBindingPattern(parameterName)) {
        const propertyNames = this.collectDestructuredPropertyNames(parameterName, sourceFile);
        destructuredProperties.push(...propertyNames);
      }
    }

    return { parameterNames, destructuredProperties };
  };

  private collectDestructuredPropertyNames = (
    bindingPattern: ts.ObjectBindingPattern,
    sourceFile: ts.SourceFile,
  ): string[] => {
    const propertyNames: string[] = [];

    for (const element of bindingPattern.elements) {
      const propertyNameNode = element.propertyName ?? element.name;
      if (ts.isIdentifier(propertyNameNode) || ts.isStringLiteral(propertyNameNode) || ts.isNumericLiteral(propertyNameNode)) {
        propertyNames.push(propertyNameNode.text);
      } else if (ts.isComputedPropertyName(propertyNameNode)) {
        propertyNames.push(propertyNameNode.expression.getText(sourceFile));
      }
      if (ts.isObjectBindingPattern(element.name)) {
        propertyNames.push(...this.collectDestructuredPropertyNames(element.name, sourceFile));
      }
    }

    return propertyNames;
  };

  private getRootIdentifierName = (expression: ts.Expression): string | null => {
    if (ts.isIdentifier(expression)) {
      return expression.text;
    }
    if (ts.isPropertyAccessExpression(expression) || ts.isPropertyAccessChain(expression)) {
      return this.getRootIdentifierName(expression.expression);
    }
    if (ts.isElementAccessExpression(expression)) {
      return this.getRootIdentifierName(expression.expression);
    }
    if (ts.isNonNullExpression(expression)) {
      return this.getRootIdentifierName(expression.expression);
    }
    if (ts.isParenthesizedExpression(expression)) {
      return this.getRootIdentifierName(expression.expression);
    }
    if (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) {
      return this.getRootIdentifierName(expression.expression);
    }
    return null;
  };

  private getPropertyNameText = (name: ts.PropertyName, sourceFile: ts.SourceFile): string | null => {
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
      return name.text;
    }
    if (ts.isComputedPropertyName(name)) {
      const computedText = name.expression.getText(sourceFile).trim();
      return computedText || null;
    }
    return null;
  };

  private hasAnyTargetNameInContent = (content: string, targetNames: string[]): boolean => {
    for (const targetName of targetNames) {
      if (targetName && content.includes(targetName)) {
        return true;
      }
    }
    return false;
  };

  private collectRelationSourcesFromFile = (filePath: string, content: string): QueryRelationSource[] => {
    const sourceFile = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      true,
    );
    const relationSources: QueryRelationSource[] = [];

    const extractCallExpression = (expression: ts.Expression): ts.CallExpression | null => {
      if (ts.isAwaitExpression(expression)) {
        return extractCallExpression(expression.expression);
      }
      if (ts.isParenthesizedExpression(expression)) {
        return extractCallExpression(expression.expression);
      }
      if (ts.isCallExpression(expression)) {
        return expression;
      }
      return null;
    };

    const visitNode = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
        const callExpression = extractCallExpression(node.initializer);
        if (callExpression) {
          const relationPaths = this.extractRelationPathsFromCallExpression(callExpression, sourceFile);
          if (relationPaths.length > 0) {
            relationSources.push({
              filePath,
              variableName: node.name.text,
              relationPaths,
              sourceText: callExpression.expression.getText(sourceFile),
            });
          }
        }
      }

      ts.forEachChild(node, visitNode);
    };

    visitNode(sourceFile);

    return relationSources;
  };

  private extractRelationPathsFromCallExpression = (
    callExpression: ts.CallExpression,
    sourceFile: ts.SourceFile,
  ): string[] => {
    const callTarget = callExpression.expression;
    const methodName = (ts.isPropertyAccessExpression(callTarget) || ts.isPropertyAccessChain(callTarget))
      ? callTarget.name.text
      : null;
    if (!methodName || ![
      'find',
      'findOne',
      'findBy',
      'findOneBy',
      'findOneOrFail',
      'findAndCount',
      'findUnique',
      'findMany',
      'findFirst',
      'findFirstOrThrow',
    ].includes(methodName)) {
      return [];
    }

    const relationPaths: string[] = [];
    for (const argument of callExpression.arguments) {
      if (!ts.isObjectLiteralExpression(argument)) {
        continue;
      }
      for (const property of argument.properties) {
        if (!ts.isPropertyAssignment(property)) {
          continue;
        }
        const propertyName = this.getPropertyNameText(property.name, sourceFile);
        if (!propertyName || !['relations', 'include', 'select'].includes(propertyName)) {
          continue;
        }
        relationPaths.push(...this.collectRelationPathsFromInitializer(property.initializer, sourceFile));
      }
    }

    return this.mergeUniqueStrings([], relationPaths);
  };

  private collectRelationPathsFromInitializer = (
    initializer: ts.Expression,
    sourceFile: ts.SourceFile,
  ): string[] => {
    if (ts.isArrayLiteralExpression(initializer)) {
      return initializer.elements
        .filter((element): element is ts.StringLiteral => ts.isStringLiteral(element))
        .map((element) => element.text)
        .filter((value) => value?.trim());
    }
    if (ts.isObjectLiteralExpression(initializer)) {
      return this.collectRelationPathsFromObjectLiteral(initializer, sourceFile, '');
    }
    return [];
  };

  private collectRelationPathsFromObjectLiteral = (
    objectLiteral: ts.ObjectLiteralExpression,
    sourceFile: ts.SourceFile,
    prefix: string,
  ): string[] => {
    const relationPaths: string[] = [];
    for (const property of objectLiteral.properties) {
      if (!ts.isPropertyAssignment(property)) {
        continue;
      }
      const propertyName = this.getPropertyNameText(property.name, sourceFile);
      if (!propertyName) {
        continue;
      }
      const nextPrefix = prefix ? `${prefix}.${propertyName}` : propertyName;
      if (ts.isObjectLiteralExpression(property.initializer)) {
        relationPaths.push(...this.collectRelationPathsFromObjectLiteral(property.initializer, sourceFile, nextPrefix));
        continue;
      }
      if (property.initializer.kind === ts.SyntaxKind.TrueKeyword) {
        relationPaths.push(nextPrefix);
      }
    }
    return relationPaths;
  };

  private buildRelationSourcesByVariableName = (relationSources: QueryRelationSource[]): Map<string, QueryRelationSource> => {
    const relationSourcesByVariableName = new Map<string, QueryRelationSource>();
    for (const relationSource of relationSources) {
      const existingSource = relationSourcesByVariableName.get(relationSource.variableName);
      if (!existingSource) {
        relationSourcesByVariableName.set(relationSource.variableName, relationSource);
        continue;
      }
      existingSource.relationPaths = this.mergeUniqueStrings(
        existingSource.relationPaths,
        relationSource.relationPaths,
      );
      if (!existingSource.sourceText) {
        existingSource.sourceText = relationSource.sourceText;
      }
    }
    return relationSourcesByVariableName;
  };

  private collectCallSiteFilePaths = async (
    targets: ParameterPropertyAccessTarget[],
    getSourceFilePaths: () => Promise<string[]>,
    getFileContent: GetFileContentFn,
  ): Promise<{
    callSiteFilesByTargetKey: Map<string, Set<string>>;
    callSiteFiles: Set<string>;
    callSitesByTargetKey: Map<string, CallSiteTraceInfo[]>;
  }> => {
    const allowedExtensions = ['.ts', '.tsx'];
    const functionTargetsByName = new Map<string, ParameterPropertyAccessTarget[]>();
    const methodTargetsByName = new Map<string, ParameterPropertyAccessTarget[]>();
    const classNameSet = new Set<string>();

    for (const target of targets) {
      if (target.kind === 'function') {
        const list = functionTargetsByName.get(target.name) ?? [];
        list.push(target);
        functionTargetsByName.set(target.name, list);
      } else {
        const list = methodTargetsByName.get(target.name) ?? [];
        list.push(target);
        methodTargetsByName.set(target.name, list);
        if (target.className) {
          classNameSet.add(target.className);
        }
      }
    }

    const targetNameList = Array.from(new Set([
      ...functionTargetsByName.keys(),
      ...methodTargetsByName.keys(),
    ]));
    const classNameList = Array.from(classNameSet);

    const callSiteFilesByTargetKey = new Map<string, Set<string>>();
    const callSiteFiles = new Set<string>();
    const callSitesByTargetKey = new Map<string, CallSiteTraceInfo[]>();

    const recordCallSite = (
      target: ParameterPropertyAccessTarget,
      filePath: string,
      calleeText: string,
      callArguments: CallSiteArgumentInfo[],
    ): void => {
      callSiteFiles.add(filePath);
      const existingSet = callSiteFilesByTargetKey.get(target.key) ?? new Set<string>();
      existingSet.add(filePath);
      callSiteFilesByTargetKey.set(target.key, existingSet);
      const existingCallSites = callSitesByTargetKey.get(target.key) ?? [];
      existingCallSites.push({
        file: filePath,
        callee: calleeText,
        arguments: callArguments,
      });
      callSitesByTargetKey.set(target.key, existingCallSites);
    };

    const sourcePaths = await getSourceFilePaths();

    for (const filePath of sourcePaths) {
      const extension = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
      if (!allowedExtensions.includes(extension)) {
        continue;
      }

      let content: string;
      try {
        content = await getFileContent(filePath);
      } catch {
        continue;
      }

      if (!content?.trim()) {
        continue;
      }

      if (!this.hasAnyTargetNameInContent(content, targetNameList)) {
        continue;
      }

      const classNamesInFile = new Set<string>();
      for (const className of classNameList) {
        if (content.includes(className)) {
          classNamesInFile.add(className);
        }
      }

      const sourceFile = ts.createSourceFile(
        filePath,
        content,
        ts.ScriptTarget.Latest,
        true,
      );
      const relationSourcesByVariableName = this.buildRelationSourcesByVariableName(
        this.collectRelationSourcesFromFile(filePath, content),
      );

      const buildCallSiteArguments = (callExpression: ts.CallExpression): CallSiteArgumentInfo[] => {
        const callArguments: CallSiteArgumentInfo[] = [];
        for (let argumentIndex = 0; argumentIndex < callExpression.arguments.length; argumentIndex += 1) {
          const argument = callExpression.arguments[argumentIndex];
          if (!ts.isIdentifier(argument)) {
            continue;
          }
          const relationSource = relationSourcesByVariableName.get(argument.text);
          if (!relationSource) {
            continue;
          }
          callArguments.push({
            index: argumentIndex,
            name: argument.text,
            relationPaths: relationSource.relationPaths,
            sourceText: relationSource.sourceText,
          });
        }
        return callArguments;
      };

      const visitNode = (node: ts.Node, currentClassName?: string): void => {
        if (ts.isClassDeclaration(node) && node.name) {
          const nextClassName = node.name.text;
          ts.forEachChild(node, (child) => visitNode(child, nextClassName));
          return;
        }

        if (ts.isCallExpression(node)) {
          const callExpressionTarget = node.expression;
          const calleeText = callExpressionTarget.getText(sourceFile);
          const callArguments = buildCallSiteArguments(node);
          if (ts.isIdentifier(callExpressionTarget)) {
            const functionTargets = functionTargetsByName.get(callExpressionTarget.text);
            if (functionTargets) {
              for (const target of functionTargets) {
                recordCallSite(target, filePath, calleeText, callArguments);
              }
            }
          } else if (ts.isPropertyAccessExpression(callExpressionTarget) || ts.isPropertyAccessChain(callExpressionTarget)) {
            const methodName = callExpressionTarget.name.text;
            const methodTargets = methodTargetsByName.get(methodName);
            if (methodTargets) {
              const objectExpression = callExpressionTarget.expression;
              if (ts.isIdentifier(objectExpression)) {
                const identifierName = objectExpression.text;
                for (const target of methodTargets) {
                  if (target.className && target.className === identifierName) {
                    recordCallSite(target, filePath, calleeText, callArguments);
                  } else if (target.className && classNamesInFile.has(target.className)) {
                    recordCallSite(target, filePath, calleeText, callArguments);
                  } else if (!target.className) {
                    recordCallSite(target, filePath, calleeText, callArguments);
                  }
                }
              } else if (objectExpression.kind === ts.SyntaxKind.ThisKeyword) {
                for (const target of methodTargets) {
                  if (target.className && target.className === currentClassName) {
                    recordCallSite(target, filePath, calleeText, callArguments);
                  }
                }
              } else {
                for (const target of methodTargets) {
                  if (!target.className || classNamesInFile.has(target.className)) {
                    recordCallSite(target, filePath, calleeText, callArguments);
                  }
                }
              }
            }
          }
        }

        ts.forEachChild(node, (child) => visitNode(child, currentClassName));
      };

      visitNode(sourceFile);
    }

    return { callSiteFilesByTargetKey, callSiteFiles, callSitesByTargetKey };
  };

  private buildTraceabilityPayload = (
    targets: ParameterPropertyAccessTarget[],
    callSiteFilesByTargetKey: Map<string, Set<string>>,
    callSitesByTargetKey: Map<string, CallSiteTraceInfo[]>,
  ): TraceabilityPayloadItem[] => {
    return targets.map((target) => {
      const callSiteFiles = Array.from(callSiteFilesByTargetKey.get(target.key) ?? []).sort();
      const callSites = callSitesByTargetKey.get(target.key) ?? [];
      const targetName = target.kind === 'method' && target.className
        ? `${target.className}.${target.name}`
        : target.name;
      return {
        target: targetName,
        definitionFile: target.filePath,
        parameterNames: [...target.parameterNames].sort(),
        destructuredProperties: [...target.destructuredProperties].sort(),
        propertyAccesses: target.propertyAccesses.slice(0, 10),
        callSiteFiles,
        callSites,
        propertyAccessEntries: target.propertyAccessEntries.slice(0, 20),
      };
    });
  };

  private findMissingRelationPath = (
    propertyPath: string,
    relationPaths: string[],
    requiresExactRelation: boolean,
  ): string | null => {
    const trimmedPropertyPath = propertyPath.trim();
    if (!trimmedPropertyPath) {
      return null;
    }
    const propertySegments = trimmedPropertyPath.split('.').filter((segment) => segment);
    if (propertySegments.length <= 1) {
      return null;
    }

    const hasRelation = (candidatePath: string): boolean => {
      return relationPaths.some((relationPath) =>
        relationPath === candidatePath || relationPath.startsWith(`${candidatePath}.`),
      );
    };

    const prefixPaths = propertySegments
      .slice(0, -1)
      .map((_, index) => propertySegments.slice(0, index + 1).join('.'));

    for (const prefixPath of prefixPaths) {
      if (!hasRelation(prefixPath)) {
        return prefixPath;
      }
    }

    if (requiresExactRelation && !hasRelation(trimmedPropertyPath)) {
      return trimmedPropertyPath;
    }

    return null;
  };

  private buildStaticRelationIssues = (
    targets: ParameterPropertyAccessTarget[],
    callSitesByTargetKey: Map<string, CallSiteTraceInfo[]>,
  ): CodeIssueInterface[] => {
    const issues: CodeIssueInterface[] = [];
    const issueKeys = new Set<string>();

    for (const target of targets) {
      if (!target.propertyAccessEntries.length) {
        continue;
      }
      const callSites = callSitesByTargetKey.get(target.key) ?? [];
      if (!callSites.length) {
        continue;
      }
      for (const entry of target.propertyAccessEntries) {
        const relevantCallSites = callSites
          .map((callSite) => {
            const argumentInfo = callSite.arguments.find((argument) => argument.index === entry.parameterIndex);
            return argumentInfo ? { callSite, argumentInfo } : null;
          })
          .filter(
            (item): item is { callSite: CallSiteTraceInfo; argumentInfo: CallSiteArgumentInfo } =>
              Boolean(item?.argumentInfo?.relationPaths?.length),
          );

        if (!relevantCallSites.length) {
          continue;
        }

        const missingCallSites = relevantCallSites
          .map(({ callSite, argumentInfo }) => {
            const missingPath = this.findMissingRelationPath(
              entry.propertyPath,
              argumentInfo.relationPaths,
              entry.requiresExactRelation,
            );
            return missingPath ? { callSite, missingPath } : null;
          })
          .filter((item): item is { callSite: CallSiteTraceInfo; missingPath: string } => Boolean(item));

        if (!missingCallSites.length) {
          continue;
        }

        const uniqueCallSiteFiles = Array.from(new Set(missingCallSites.map((item) => item.callSite.file)));
        const callSiteFilesText = uniqueCallSiteFiles.slice(0, 3).join(', ');
        const missingRelationPath = missingCallSites[0].missingPath;
        const message = `Свойство "${entry.propertyPath}" может быть не загружено: в вызовах ${callSiteFilesText} отсутствует связь "${missingRelationPath}".`;
        const issueKey = `${target.filePath}:${entry.line}:${message}`;
        if (issueKeys.has(issueKey)) {
          continue;
        }
        issueKeys.add(issueKey);
        issues.push({
          file: target.filePath,
          line: entry.line,
          severity: 'error',
          message,
          rule: 'logical-query-result-mismatch',
        });
      }
    }

    return issues;
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
