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
}

@Singleton
export class ScmPushAnalysisService {
  private readonly TAG = 'ScmPushAnalysisService';

  private readonly affectedFilesService = Container.get(AffectedFilesService);

  private readonly loggerService = Container.get(LoggerService);

  private readonly scmReviewService = Container.get(ScmReviewService);

  public run = async (options: RunPushAnalysisOptions): Promise<RunPushAnalysisResult> => {
    const { driver, changedPaths, commits, summaryTitle, errorContext } = options;

    this.loggerService.info(this.TAG, `Starting push analysis: ${changedPaths.length} changed paths, ${commits.length} commits`);

    try {
      const changes = await driver.getInitialChanges();
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

      const getFileContent = driver.getAffectedPathsInput().getFileContent;
      const analysisResult = await this.scmReviewService.analyzeAndSummarizeChanges(
        mergedChanges,
        commits,
        summaryTitle,
        { getFileContent },
      );

      const commitsSummary = this.scmReviewService.buildCommitsSummary(commits);

      this.loggerService.info(this.TAG, 'Push analysis completed successfully');

      return {
        analysisSummary: analysisResult.analysisSummary,
        humanSummary: analysisResult.humanSummary,
        commitsSummary,
      };
    } catch (error) {
      const errorInstance = error as Error;
      this.loggerService.error(this.TAG, errorContext, errorInstance);

      const commitsSummary = this.scmReviewService.buildCommitsSummary(commits);

      return {
        analysisSummary: this.scmReviewService.buildAnalysisErrorSummary(error),
        humanSummary: '',
        commitsSummary,
      };
    }
  };
}
