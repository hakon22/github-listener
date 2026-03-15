import { Container, Singleton } from 'typescript-ioc';

import { AffectedFilesService } from '@/services/analysis/affected-files.service';
import { LoggerService } from '@/services/core/logger.service';
import { ScmReviewService } from '@/services/scm/scm-review.service';
import type { AffectedFilesInput } from '@/services/analysis/affected-files.service';
import type { ScmChangeInterface } from '@/interfaces/scm-change.interface';
import type { ScmCommitSummaryInterface } from '@/services/scm/scm-review.service';

export interface ScmPushAnalysisDriver {
  getInitialChanges: () => Promise<ScmChangeInterface[]>;
  getSnapshot: (paths: string[]) => Promise<ScmChangeInterface[]>;
  getAffectedPathsInput: () => AffectedFilesInput;
}

export interface RunPushAnalysisOptions {
  driver: ScmPushAnalysisDriver;
  changedPaths: string[];
  commits: ScmCommitSummaryInterface[];
  summaryTitle: string;
  errorContext: string;
}

export interface RunPushAnalysisResult {
  analysisSummary: string;
  humanSummary: string;
  commitsSummary: string;
  processedFilesCount: number;
  processedFilePaths: string[];
}

@Singleton
export class ScmPushAnalysisService {
  private readonly TAG = 'ScmPushAnalysisService';

  private readonly affectedFilesService = Container.get(AffectedFilesService);

  private readonly loggerService = Container.get(LoggerService);

  private readonly scmReviewService = Container.get(ScmReviewService);

  public run = async (options: RunPushAnalysisOptions): Promise<RunPushAnalysisResult> => {
    const { driver, changedPaths: changedPathsOption, commits, summaryTitle, errorContext } = options;

    try {
      const changes = await driver.getInitialChanges();
      const changedPaths = changedPathsOption.length > 0
        ? changedPathsOption
        : changes.map((change) => change.file);

      this.loggerService.info(this.TAG, `Starting push analysis: ${changedPaths.length} changed paths, ${commits.length} commits`);

      let mergedChanges = changes;

      if (process.env.IMPACT_ANALYSIS_ENABLED !== 'false') {
        try {
          const affectedPaths = await this.affectedFilesService.getAffectedPaths(
            changedPaths,
            driver.getAffectedPathsInput(),
            { affectedFileLimit: 50 },
          );

          const changedSet = new Set(changedPaths);
          const pathsToFetch = affectedPaths.filter((filePath) => !changedSet.has(filePath));

          if (pathsToFetch.length > 0) {
            const affectedChanges = await driver.getSnapshot(pathsToFetch);
            mergedChanges = [...changes, ...affectedChanges];
          }
        } catch (e) {
          this.loggerService.warn(this.TAG, 'Impact analysis failed, analyzing only changed files', e);
        }
      }

      // Фильтрация неанализируемых файлов (.md, package-lock.json) — ScmReviewService.isExcludedFromAnalysis.
      const affectedInput = driver.getAffectedPathsInput();
      const analysisResult = await this.scmReviewService.analyzeAndSummarizeChanges(
        mergedChanges,
        commits,
        summaryTitle,
        {
          getFileContent: affectedInput.getFileContent,
          getSourceFilePaths: affectedInput.getSourceFilePaths,
        },
      );

      const commitsSummary = this.scmReviewService.buildCommitsSummary(commits);
      const analyzableChanges = mergedChanges.filter(
        (change) => !ScmReviewService.isExcludedFromAnalysis(change.file),
      );

      // Для детализации показываем только файлы, которые не были изменены в коммите,
      // а были дополнительно загружены моделью по связям (impact analysis).
      const normalizePath = (filePath: string): string => filePath.replace(/\\/g, '/');
      const changedFilePathSet = new Set(
        changedPaths.map((filePath) => normalizePath(filePath)),
      );
      const processedFilePaths = analyzableChanges
        .map((change) => normalizePath(change.file))
        .filter((filePath) => !changedFilePathSet.has(filePath));

      this.loggerService.info(this.TAG, 'Push analysis completed successfully');

      return {
        analysisSummary: analysisResult.analysisSummary,
        humanSummary: analysisResult.humanSummary,
        commitsSummary,
        processedFilesCount: processedFilePaths.length,
        processedFilePaths,
      };
    } catch (error) {
      const errorInstance = error as Error;
      this.loggerService.error(this.TAG, errorContext, errorInstance);

      const commitsSummary = this.scmReviewService.buildCommitsSummary(commits);

      return {
        analysisSummary: this.scmReviewService.buildAnalysisErrorSummary(error),
        humanSummary: '',
        commitsSummary,
        processedFilesCount: 0,
        processedFilePaths: [],
      };
    }
  };
}
