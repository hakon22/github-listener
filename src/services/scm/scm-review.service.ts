import * as path from 'path';
import { Container, Singleton } from 'typescript-ioc';

import { AIService } from '@/services/analysis/ai.service';
import type { AICodeIssueRecommendation, GetFileContentFn, LogicalDataLoadingOptions } from '@/services/analysis/ai.service';
import { CodeAnalyzerService } from '@/services/analysis/code-analyzer.service';
import type { ScmChangeInterface } from '@/interfaces/scm-change.interface';
import { VectorStoreService } from '@/services/analysis/vector-store.service';

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

interface CategorizedRecommendationsInterface {
  criticalRecommendations: AICodeIssueRecommendation[];
  warningRecommendations: AICodeIssueRecommendation[];
  infoRecommendations: AICodeIssueRecommendation[];
}

@Singleton
export class ScmReviewService {
  private static readonly TOP_ISSUES_LIMIT = 3;

  public static isMarkdownFile = (filePath: string): boolean =>
    filePath.toLowerCase().replace(/\\/g, '/').endsWith('.md');

  private readonly analyzerService = Container.get(CodeAnalyzerService);

  private readonly aiService = Container.get(AIService);

  private readonly vectorStoreService = Container.get(VectorStoreService);

  public analyzeAndSummarizeChanges = async (
    changes: ScmChangeInterface[],
    commits: ScmCommitSummaryInterface[],
    summaryTitle: string,
    options?: { getFileContent?: GetFileContentFn; getSourceFilePaths?: () => Promise<string[]>; },
  ): Promise<{ analysisSummary: string; humanSummary: string; }> => {
    const analyzableChanges = changes.filter((change) => !ScmReviewService.isMarkdownFile(change.file));
    const recommendations = await this.getRecommendationsForChanges(analyzableChanges, options);
    const categorizedRecommendations = this.categorizeRecommendations(recommendations);

    const topIssues = [
      ...categorizedRecommendations.criticalRecommendations,
      ...categorizedRecommendations.warningRecommendations,
    ].slice(0, ScmReviewService.TOP_ISSUES_LIMIT);

    const humanSummary = await this.aiService.summarizePush(
      commits,
      topIssues,
      analyzableChanges,
    );

    const analysisSummary = this.buildAnalysisSummary(
      summaryTitle,
      categorizedRecommendations,
      topIssues,
      analyzableChanges,
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
    const analyzableChanges = changes.filter((change) => !ScmReviewService.isMarkdownFile(change.file));
    await this.vectorStoreService.indexMergeRequestChanges(analyzableChanges);

    const analysis = await this.analyzerService.analyzeChanges(analyzableChanges);
    const logicalDataIssues = process.env.USE_UNIFIED_AI_ANALYSIS === 'true'
      ? await this.aiService.getUnifiedAnalysisIssues(analyzableChanges)
      : await this.aiService.getLogicalDataLoadingIssues(analyzableChanges, options);
    const allIssues = [...analysis, ...logicalDataIssues];
    return this.aiService.getRecommendations(allIssues);
  };

  public buildAnalysisErrorSummary = (error: unknown): string => {
    const errorInstance = error as Error;
    const errorText = this.escapeHtml(
      errorInstance?.stack
        || `${errorInstance?.name || 'Error'}: ${errorInstance?.message || String(error)}`
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

  private normalizePath = (filePath: string): string => path.normalize(filePath).replace(/\\/g, '/');

  private categorizeRecommendations = (
    recommendations: AICodeIssueRecommendation[],
  ): CategorizedRecommendationsInterface => ({
    criticalRecommendations: recommendations.filter(
      (recommendation) => recommendation.severity === 'error' || recommendation.type === 'security',
    ),
    warningRecommendations: recommendations.filter(
      (recommendation) => recommendation.severity === 'warning',
    ),
    infoRecommendations: recommendations.filter(
      (recommendation) => recommendation.severity === 'info',
    ),
  });

  private static readonly SNIPPET_CONTEXT_LINES = 2;

  private getCodeSnippet = (content: string, lineOneBased: number): string => {
    const lines = content.split('\n');
    const lineIndex = lineOneBased - 1;
    const start = Math.max(0, lineIndex - ScmReviewService.SNIPPET_CONTEXT_LINES);
    const end = Math.min(lines.length, lineIndex + ScmReviewService.SNIPPET_CONTEXT_LINES + 1);
    const snippetLines = lines.slice(start, end);
    return snippetLines
      .map((line, index) => {
        const currentLineNum = start + index + 1;
        const marker = currentLineNum === lineOneBased ? ' →' : '  ';
        return `${currentLineNum}${marker} ${line}`;
      })
      .join('\n');
  };

  private buildAnalysisSummary = (
    summaryTitle: string,
    categorizedRecommendations: CategorizedRecommendationsInterface,
    topIssues: AICodeIssueRecommendation[],
    changes: ScmChangeInterface[],
  ): string => {
    const contentByFile = new Map<string, string>();
    for (const change of changes) {
      contentByFile.set(this.normalizePath(change.file), change.newContent);
    }

    const issueLines = topIssues.map((recommendation, index) => {
      const location = `${recommendation.file}:${recommendation.line}`;
      const header = `${index + 1}. [${this.escapeHtml(recommendation.type)}] <code>${this.escapeHtml(location)}</code>`;

      const description = this.escapeHtml(recommendation.message);
      const impact = recommendation.impact ? this.escapeHtml(recommendation.impact) : '';
      const suggestion = recommendation.suggestion ? this.escapeHtml(recommendation.suggestion) : '';

      const parts: string[] = [`${header} — ${description}`];

      const content = contentByFile.get(this.normalizePath(recommendation.file));
      if (content) {
        const snippet = this.getCodeSnippet(content, recommendation.line);
        if (snippet.trim()) {
          parts.push(`<pre><code>${this.escapeHtml(snippet)}</code></pre>`);
        }
      }

      if (impact) {
        parts.push(`  Возможные последствия: ${impact}`);
      }
      if (suggestion) {
        parts.push(`  Рекомендация: ${suggestion}`);
      }

      return parts.join('\n');
    });

    const summaryLines: string[] = [
      '',
      summaryTitle,
      `Критические: <b>${categorizedRecommendations.criticalRecommendations.length}</b>, предупреждения: <b>${categorizedRecommendations.warningRecommendations.length}</b>, info: <b>${categorizedRecommendations.infoRecommendations.length}</b>.`,
    ];

    if (issueLines.length) {
      summaryLines.push('', 'Топ проблем:', ...issueLines);
    }

    return summaryLines.join('\n');
  };
}
