import { Container, Singleton } from 'typescript-ioc';

import { AIService } from '@/services/analysis/ai.service';
import type { AICodeIssueRecommendation } from '@/services/analysis/ai.service';
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

  private readonly analyzerService = Container.get(CodeAnalyzerService);

  private readonly aiService = Container.get(AIService);

  private readonly vectorStoreService = Container.get(VectorStoreService);

  public analyzeAndSummarizeChanges = async (
    changes: ScmChangeInterface[],
    commits: ScmCommitSummaryInterface[],
    summaryTitle: string,
  ): Promise<{ analysisSummary: string; humanSummary: string; }> => {
    const recommendations = await this.getRecommendationsForChanges(changes);
    const categorizedRecommendations = this.categorizeRecommendations(recommendations);

    const topIssues = [
      ...categorizedRecommendations.criticalRecommendations,
      ...categorizedRecommendations.warningRecommendations,
    ].slice(0, ScmReviewService.TOP_ISSUES_LIMIT);

    const humanSummary = await this.aiService.summarizePush(
      commits,
      topIssues,
      changes,
    );

    const analysisSummary = this.buildAnalysisSummary(
      summaryTitle,
      categorizedRecommendations,
      topIssues,
    );

    return {
      analysisSummary,
      humanSummary,
    };
  };

  public getRecommendationsForChanges = async (
    changes: ScmChangeInterface[],
  ): Promise<AICodeIssueRecommendation[]> => {
    await this.vectorStoreService.indexMergeRequestChanges(changes);

    const analysis = await this.analyzerService.analyzeChanges(changes);
    return this.aiService.getRecommendations(analysis);
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

  private buildAnalysisSummary = (
    summaryTitle: string,
    categorizedRecommendations: CategorizedRecommendationsInterface,
    topIssues: AICodeIssueRecommendation[],
  ): string => {
    const issueLines = topIssues.map((recommendation, index) => {
      const location = `${recommendation.file}:${recommendation.line}`;
      const header = `${index + 1}. [${this.escapeHtml(recommendation.type)}] <code>${this.escapeHtml(location)}</code>`;

      const description = this.escapeHtml(recommendation.message);
      const impact = recommendation.impact ? this.escapeHtml(recommendation.impact) : '';
      const suggestion = recommendation.suggestion ? this.escapeHtml(recommendation.suggestion) : '';

      const parts: string[] = [`${header} — ${description}`];
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
