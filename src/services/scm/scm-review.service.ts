import * as path from 'path';
import { Container, Singleton } from 'typescript-ioc';

import { AIService } from '@/services/analysis/ai.service';
import { CodeAnalyzerService } from '@/services/analysis/code-analyzer.service';
import { deduplicateIssues } from '@/services/analysis/false-positive-filters';
import {
  buildIssueFilterContext,
  filterCodeIssues,
  sanitizeHumanSummary,
} from '@/services/analysis/issue-filter.service';
import { VectorStoreService } from '@/services/analysis/vector-store.service';
import type { ScmChangeInterface } from '@/interfaces/scm-change.interface';
import type { AICodeIssueRecommendation, GetFileContentFn, LogicalDataLoadingOptions } from '@/services/analysis/ai.service';

export interface ScmCommitSummaryInterface {
  id: string;
  message: string;
  files: string[];
}

export interface ScmFileChangeCommitInterface {
  added?: string[];
  modified?: string[];
  removed?: string[];
}

@Singleton
export class ScmReviewService {
  private static readonly TOP_ISSUES_LIMIT = 5;

  public static isMarkdownFile = (filePath: string): boolean =>
    filePath.toLowerCase().replace(/\\/g, '/').endsWith('.md');

  /** Файлы, которые не отправляются в анализ модели (lock-файлы, markdown и т.д.). */
  public static isExcludedFromAnalysis = (filePath: string): boolean => {
    const normalized = filePath.toLowerCase().replace(/\\/g, '/');
    return normalized.endsWith('.md') || normalized.endsWith('package-lock.json');
  };

  private readonly analyzerService = Container.get(CodeAnalyzerService);

  private readonly aiService = Container.get(AIService);

  private readonly vectorStoreService = Container.get(VectorStoreService);

  public analyzeAndSummarizeChanges = async (
    changes: ScmChangeInterface[],
    commits: ScmCommitSummaryInterface[],
    summaryTitle: string,
    options?: {
      getFileContent?: GetFileContentFn;
      getSourceFilePaths?: () => Promise<string[]>;
      changedPaths?: Set<string>;
    },
  ): Promise<{ analysisSummary: string; humanSummary: string; }> => {
    const analyzableChanges = changes.filter((change) => !ScmReviewService.isExcludedFromAnalysis(change.file));
    const recommendations = await this.getRecommendationsForChanges(analyzableChanges, options);
    const criticalRecommendations = this.getCriticalRecommendations(recommendations);
    const topIssues = criticalRecommendations.slice(0, ScmReviewService.TOP_ISSUES_LIMIT);

    const rawHumanSummary = await this.aiService.summarizePush(
      commits,
      topIssues,
      analyzableChanges,
    );
    const humanSummary = sanitizeHumanSummary(rawHumanSummary, criticalRecommendations.length);

    const analysisSummary = await this.buildAnalysisSummary(
      summaryTitle,
      criticalRecommendations.length,
      topIssues,
      analyzableChanges,
      options?.getFileContent,
    );

    return {
      analysisSummary,
      humanSummary,
    };
  };

  public getRecommendationsForChanges = async (
    changes: ScmChangeInterface[],
    options?: LogicalDataLoadingOptions | GetFileContentFn,
  ): Promise<AICodeIssueRecommendation[]> => {
    const analyzableChanges = changes.filter((change) => !ScmReviewService.isExcludedFromAnalysis(change.file));
    await this.vectorStoreService.indexMergeRequestChanges(analyzableChanges);

    const analysis = await this.analyzerService.analyzeChanges(analyzableChanges);
    const changedPaths = (
      typeof options === 'object'
      && options !== null
      && 'changedPaths' in options
    )
      ? (options as { changedPaths?: Set<string>; }).changedPaths
      : undefined;

    const logicalDataIssues = process.env.USE_UNIFIED_AI_ANALYSIS === 'true'
      ? await this.aiService.getUnifiedAnalysisIssues(analyzableChanges, changedPaths)
      : await this.aiService.getLogicalDataLoadingIssues(analyzableChanges, options);
    const logicalOptions: LogicalDataLoadingOptions =
      typeof options === 'function'
        ? { getFileContent: options }
        : options ?? {};

    const entitySchemaIssues = await this.aiService.getEntitySchemaChangeIssues(
      analysis,
      logicalOptions,
    );

    // Обобщённый кандидат "схема изменилась — проверьте все места" не показываем:
    // только конкретные находки ИИ по использованию сущностей (logical-entity-usage).
    const analysisWithoutEntitySchemaPrompt = analysis.filter(
      (issue) => issue.rule !== 'logical-entity-schema-change',
    );

    const allIssues = [...analysisWithoutEntitySchemaPrompt, ...logicalDataIssues, ...entitySchemaIssues].filter(
      (issue) => issue.severity === 'error',
    );

    const filterContext = buildIssueFilterContext(analyzableChanges, changedPaths);
    const filteredIssues = filterCodeIssues(allIssues, filterContext);

    const recommendations = await this.aiService.getRecommendations(filteredIssues);
    const filteredRecommendations = this.filterRecommendations(recommendations, filterContext);
    return this.getCriticalRecommendations(filteredRecommendations);
  };

  public buildAnalysisErrorSummary = (error: unknown): string => {
    const errorInstance = error as Error;
    const rawMessage = `${errorInstance?.name || 'Error'}: ${errorInstance?.message || String(error)}`;

    const isRefNotFound = /Ref Not Found/i.test(rawMessage) || /Reference does not exist/i.test(rawMessage);

    if (isRefNotFound) {
      const friendly = this.escapeHtml(
        'Не удалось получить diff по push: указанная ветка или коммит больше не доступны (возможен force-push или удаление ветки). Анализ кода для этого события не выполнялся.',
      );
      const technical = this.escapeHtml(errorInstance?.stack || rawMessage);

      return `\n<b>Внимание:</b> не удалось выполнить анализ кода:\n${friendly}\n<pre><code>${technical}</code></pre>`;
    }

    const errorText = this.escapeHtml(
      errorInstance?.stack
        || rawMessage
        || String(error),
    );

    return `\n<b>Внимание:</b> не удалось выполнить анализ кода:\n<pre><code>${errorText}</code></pre>`;
  };

  public collectChangedFiles = (commits: ScmFileChangeCommitInterface[]): Set<string> => {
    const changedFiles = new Set<string>();

    for (const commit of commits) {
      (commit.added ?? []).forEach((filePath) => changedFiles.add(filePath));
      (commit.modified ?? []).forEach((filePath) => changedFiles.add(filePath));
      (commit.removed ?? []).forEach((filePath) => changedFiles.add(filePath));
    }

    return changedFiles;
  };

  public buildCommitsSummary = (commits: Array<{ id: string; message: string; }>): string => commits
    .slice(0, 5)
    .map((commit) => {
      const shortId = commit.id.slice(0, 8);
      const firstLineMessage = commit.message.split('\n')[0] ?? '';
      return `- <code>${shortId}</code>: ${this.escapeHtml(firstLineMessage)}`;
    })
    .join('\n');

  public escapeHtml = (value: string): string => value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  /**
   * Типы проблем, которые разрешено включать в Telegram‑отчёт.
   * Если переменная окружения ANALYSIS_ALLOWED_TYPES не задана,
   * используется дефолтное поведение (severity === "error" или type === "security"),
   * но при этом type "quality" и "best_practice" всегда исключаются.
   */
  private getAllowedTypesFromEnv = (): Set<AICodeIssueRecommendation['type']> | null => {
    const raw = process.env.ANALYSIS_ALLOWED_TYPES;
    if (!raw) {
      return null;
    }

    const parts = raw
      .split(',')
      .map((part) => part.trim())
      .filter((part): part is AICodeIssueRecommendation['type'] =>
        part === 'quality'
        || part === 'security'
        || part === 'performance'
        || part === 'best_practice',
      );

    if (!parts.length) {
      return null;
    }

    return new Set(parts);
  };

  /**
   * Список ESLint/логических правил, которые нужно полностью исключить из итогового отчёта.
   * Например: ANALYSIS_EXCLUDED_RULES=logical-function-signature-change,logical-entity-schema-change
   */
  private getExcludedRulesFromEnv = (): Set<string> => {
    const raw = process.env.ANALYSIS_EXCLUDED_RULES;
    if (!raw) {
      return new Set();
    }

    const parts = raw
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);

    return new Set(parts);
  };

  private normalizePath = (filePath: string): string => path.normalize(filePath).replace(/\\/g, '/');

  private getCriticalRecommendations = (
    recommendations: AICodeIssueRecommendation[],
  ): AICodeIssueRecommendation[] => {
    const allowedTypes = this.getAllowedTypesFromEnv();
    const excludedRules = this.getExcludedRulesFromEnv();

    const byRuleFiltered = recommendations.filter(
      (recommendation) => !excludedRules.has(recommendation.rule),
    );

    if (allowedTypes && allowedTypes.size > 0) {
      return byRuleFiltered.filter((recommendation) => allowedTypes.has(recommendation.type));
    }

    // Только severity error; quality/best_practice и чистый AI-performance без доказанного crash — исключены.
    return byRuleFiltered.filter(
      (recommendation) =>
        recommendation.severity === 'error'
        && recommendation.type !== 'quality'
        && recommendation.type !== 'best_practice'
        && recommendation.type !== 'performance',
    );
  };

  private filterRecommendations = (
    recommendations: AICodeIssueRecommendation[],
    filterContext: ReturnType<typeof buildIssueFilterContext>,
  ): AICodeIssueRecommendation[] => {
    const asIssues = recommendations.map((recommendation) => ({
      file: recommendation.file,
      line: recommendation.line,
      severity: recommendation.severity,
      message: recommendation.message,
      rule: recommendation.rule,
      suggestion: recommendation.suggestion,
    }));
    const kept = new Set(
      filterCodeIssues(asIssues, filterContext).map((issue) => `${issue.file}:${issue.line}:${issue.message}`),
    );
    const filtered = recommendations.filter((recommendation) =>
      kept.has(`${recommendation.file}:${recommendation.line}:${recommendation.message}`),
    );
    return deduplicateIssues(filtered);
  };

  private static readonly SNIPPET_CONTEXT_LINES = 2;

  private getCodeSnippet = (content: string, lineOneBased: number): string => {
    const lines = content.split('\n');
    const lineIndex = lineOneBased - 1;
    const start = Math.max(0, lineIndex - ScmReviewService.SNIPPET_CONTEXT_LINES);
    const end = Math.min(lines.length, lineIndex + ScmReviewService.SNIPPET_CONTEXT_LINES + 1);
    const snippetLines = lines.slice(start, end);
    return snippetLines
      .map((snippetLine, index) => {
        const currentLineNum = start + index + 1;
        const marker = currentLineNum === lineOneBased ? ' →' : '  ';
        return `${currentLineNum}${marker} ${snippetLine}`;
      })
      .join('\n');
  };

  /**
   * Для проблем загрузки данных сниппет должен показывать строку, где обращаются к свойству,
   * а не find/if/закрывающие скобки. Если указанная строка пустая — стрелка сдвигается на ближайшую непустую с кодом.
   */
  private getSnippetLineForIssue = (
    content: string,
    recommendation: AICodeIssueRecommendation,
  ): number => {
    const lines = content.split('\n');
    const reportedLine = Math.min(Math.max(1, recommendation.line), lines.length);
    const reportedIndex = reportedLine - 1;
    const lineAtReported = lines[reportedIndex] ?? '';

    if (lineAtReported.trim() === '') {
      for (let offset = 1; offset < lines.length; offset += 1) {
        const nextIndex = reportedIndex + offset;
        if (nextIndex < lines.length && lines[nextIndex]?.trim() !== '') {
          return nextIndex + 1;
        }
        const prevIndex = reportedIndex - offset;
        if (prevIndex >= 0 && lines[prevIndex]?.trim() !== '') {
          return prevIndex + 1;
        }
      }
    }

    const propertySegment = this.extractPropertySegmentFromMessage(recommendation.message);
    if (!propertySegment) {
      return reportedLine;
    }
    const snippetAtReported = this.getCodeSnippet(content, reportedLine);
    if (snippetAtReported.includes(propertySegment)) {
      return reportedLine;
    }
    const escaped = this.escapeRegex(propertySegment);
    const segmentPattern = new RegExp(
      `\\.${escaped}(?:\\.|\\b)|['"]${escaped}['"]`,
    );
    let bestLine = reportedLine;
    let bestDistance = lines.length;
    for (let index = 0; index < lines.length; index += 1) {
      if (segmentPattern.test(lines[index])) {
        const distance = Math.abs(index - reportedIndex);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestLine = index + 1;
        }
      }
    }
    return bestLine;
  };

  private escapeRegex = (string: string): string =>
    string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  private extractPropertySegmentFromMessage = (message: string): string | null => {
    const patterns: RegExp[] = [
      /(?:Свойство|свойство)[:\s]*["']?([^"'\s\]]+)["']?/i,
      /Поле\s+["']([^"']+)["']/i,
      /['"]([a-zA-Z0-9_.]+\.[a-zA-Z0-9_.]+(?:\.[a-zA-Z0-9_.]+)*)['"].*relations/i,
      /relations.*['"]([a-zA-Z0-9_.]+)['"]/i,
      /(?:добавьте|в массив relations).*['"]([a-zA-Z0-9_.]+)['"]/i,
    ];
    for (const pattern of patterns) {
      const match = message.match(pattern);
      const path = match?.[1]?.trim();
      if (path) {
        const lastSegment = path.split('.').filter(Boolean).pop();
        return lastSegment ?? path;
      }
    }
    return null;
  };

  private buildAnalysisSummary = async (
    summaryTitle: string,
    criticalCount: number,
    topIssues: AICodeIssueRecommendation[],
    changes: ScmChangeInterface[],
    getFileContent?: (filePath: string) => Promise<string>,
  ): Promise<string> => {
    if (criticalCount === 0 && topIssues.length === 0) {
      return '';
    }

    const contentByFile = new Map<string, string>();
    for (const change of changes) {
      contentByFile.set(this.normalizePath(change.file), change.newContent ?? '');
    }

    const issueLines: string[] = [];
    for (let index = 0; index < topIssues.length; index += 1) {
      const recommendation = topIssues[index];
      let content = contentByFile.get(this.normalizePath(recommendation.file));
      if (content === undefined && getFileContent) {
        try {
          content = await getFileContent(recommendation.file);
        } catch {
          content = undefined;
        }
      }
      const snippetLine = content
        ? this.getSnippetLineForIssue(content, recommendation)
        : recommendation.line;
      const location = `${recommendation.file}:${snippetLine}`;
      const header = `${index + 1}. [${this.escapeHtml(recommendation.type)}] <code>${this.escapeHtml(location)}</code>`;

      const description = this.escapeHtml(recommendation.message);
      const impact = recommendation.impact ? this.escapeHtml(recommendation.impact) : '';
      const suggestion = recommendation.suggestion ? this.escapeHtml(recommendation.suggestion) : '';

      const parts: string[] = [`${header} — ${description}`];

      if (content) {
        const snippet = this.getCodeSnippet(content, snippetLine);
        if (snippet.trim()) {
          const fileLabel = this.escapeHtml(path.basename(recommendation.file)).replace(/\s+/g, '_');
          parts.push(`<pre><code class="language-${fileLabel}">${this.escapeHtml(snippet)}</code></pre>`);
        }
      }

      if (impact) {
        parts.push(`  Возможные последствия: ${impact}`);
      }
      if (suggestion) {
        parts.push(`  Рекомендация: ${suggestion}`);
      }

      issueLines.push(parts.join('\n'));
    }

    const summaryLines: string[] = [
      '',
      summaryTitle,
      `Критические: <b>${criticalCount}</b>.`,
    ];

    if (issueLines.length) {
      summaryLines.push('', 'Топ проблем:', ...issueLines);
    }

    return summaryLines.join('\n');
  };
}
