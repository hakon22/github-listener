import type { Request, Response } from 'express';
import { Container, Singleton } from 'typescript-ioc';

import { BaseService } from '@/services/core/base.service';
import { GitlabAgentService } from '@/services/scm/agents/gitlab-agent.service';
import { ScmReviewService } from '@/services/scm/scm-review.service';
import { ScmNotificationService } from '@/services/scm/scm-notification.service';
import { ScmPushAnalysisService } from '@/services/scm/scm-push-analysis.service';

interface GitlabMergeRequestEvent {
  object_kind: 'merge_request';
  project: {
    id: number;
  };
  object_attributes: {
    iid: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface GitlabPushCommit {
  id: string;
  message: string;
  url?: string;
  added?: string[];
  modified?: string[];
  removed?: string[];
}

interface GitlabPushEvent {
  object_kind: 'push';
  ref: string;
  before?: string;
  after?: string;
  user_name?: string;
  user_username?: string;
  total_commits_count?: number;
  project: {
    id: number;
    name?: string;
    path_with_namespace?: string;
    web_url?: string;
  };
  commits: GitlabPushCommit[];
  [key: string]: unknown;
}

@Singleton
export class GitlabWebhookController extends BaseService {
  protected override readonly TAG: string = 'GitlabWebhookController';

  private readonly gitlabAgentService = Container.get(GitlabAgentService);

  private readonly scmPushAnalysisService = Container.get(ScmPushAnalysisService);

  private readonly scmReviewService = Container.get(ScmReviewService);

  private readonly scmNotificationService = Container.get(ScmNotificationService);

  public onWebhookMessage = (req: Request, res: Response): Response => {
    try {
      const eventKind = (req.body as { object_kind?: string; } | undefined)?.object_kind;

      this.loggerService.info(this.TAG, `Received GitLab webhook: event=${eventKind ?? 'unknown'}`);

      if (eventKind === 'merge_request') {
        this.defer(() => this.handleMergeRequest(req.body as GitlabMergeRequestEvent));
      } else if (eventKind === 'push') {
        this.defer(() => this.handlePush(req.body as GitlabPushEvent));
      } else {
        this.loggerService.debug(this.TAG, `Ignored GitLab event: ${eventKind}`);
      }

      return res.status(200).json({ status: 'processing' });
    } catch (error) {
      return this.handleWebhookProcessingError('GitLab', error, res);
    }
  };

  private handleMergeRequest = async (event: GitlabMergeRequestEvent): Promise<void> => {
    const projectId = event.project.id;
    const mergeRequestIid = event.object_attributes.iid;
    const ref = (event.object_attributes.source_branch as string) ?? 'main';

    this.loggerService.info(this.TAG, `Processing GitLab merge_request: projectId=${projectId}, MR !${mergeRequestIid}`);

    const changes = await this.gitlabAgentService.getMergeRequestChanges(projectId, mergeRequestIid);
    const getFileContent = (filePath: string) => this.gitlabAgentService.getFileContentAtRef(
      projectId,
      filePath,
      ref,
    );
    const getSourceFilePaths = () => this.gitlabAgentService.getRepositorySourceFilePaths(
      projectId,
      ref,
      { maxFiles: 200 },
    );
    const recommendations = await this.scmReviewService.getRecommendationsForChanges(changes, {
      getFileContent,
      getSourceFilePaths,
    });

    await this.gitlabAgentService.addComments(projectId, mergeRequestIid, recommendations);

    this.loggerService.info(this.TAG, `GitLab merge_request !${mergeRequestIid} processed, comments added`);
  };

  private handlePush = async (event: GitlabPushEvent): Promise<void> => {
    const projectId = event.project.id;
    const projectName = event.project.path_with_namespace
      || event.project.name
      || `ID ${projectId}`;

    const branch = event.ref.replace(/^refs\/heads\//, '');
    const author = event.user_name || event.user_username || 'неизвестен';

    this.loggerService.info(this.TAG, `Processing GitLab push: project=${projectName}, branch=${branch}, author=${author}`);

    const commits = event.commits ?? [];
    const commitsCount = event.total_commits_count ?? commits.length;

    const changedFiles = this.scmReviewService.collectChangedFiles(commits);
    const filesCount = changedFiles.size;

    let analysisSummary = '';
    let humanSummary = '';
    let commitsSummary = '';
    let pushResult: Awaited<ReturnType<ScmPushAnalysisService['run']>> | undefined;

    if (filesCount > 0) {
      const changedPaths = Array.from(changedFiles);
      const ref = event.after ?? branch;

      pushResult = await this.scmPushAnalysisService.run({
        driver: {
          getInitialChanges: () => (event.before && event.after
            ? this.gitlabAgentService.getPushChanges(projectId, event.before, event.after, changedPaths)
            : this.gitlabAgentService.getFilesSnapshot(projectId, branch, changedPaths)),
          getSnapshot: (paths) => this.gitlabAgentService.getFilesSnapshot(projectId, ref, paths),
          getAffectedPathsInput: () => ({
            getSourceFilePaths: () => this.gitlabAgentService.getRepositorySourceFilePaths(
              projectId,
              ref,
              { maxFiles: 200 },
            ),
            getFileContent: (filePath) => this.gitlabAgentService.getFileContentAtRef(
              projectId,
              filePath,
              ref,
            ),
          }),
        },
        changedPaths,
        commits: commits.map((commit) => ({
          id: commit.id,
          message: commit.message,
          files: [
            ...(commit.added ?? []),
            ...(commit.modified ?? []),
            ...(commit.removed ?? []),
          ],
        })),
        summaryTitle: '<b>Результаты анализа кода</b>',
        errorContext: 'Failed to analyze code for GitLab push event',
      });

      analysisSummary = pushResult.analysisSummary;
      humanSummary = pushResult.humanSummary;
      commitsSummary = pushResult.commitsSummary;
    } else {
      commitsSummary = this.scmReviewService.buildCommitsSummary(commits);
    }

    const messageText = this.scmNotificationService.buildPushNotificationText({
      providerName: 'GitLab',
      targetLabel: 'Проект',
      targetName: this.scmReviewService.escapeHtml(projectName),
      branch: this.scmReviewService.escapeHtml(branch),
      author: this.scmReviewService.escapeHtml(author),
      commitsCount,
      filesCount,
      humanSummary: this.scmReviewService.escapeHtml(humanSummary),
      commitsSummary,
      analysisSummary,
      processedFilesCount: pushResult?.processedFilesCount,
      processedFilePaths: pushResult?.processedFilePaths,
    });
    await this.telegramService.sendAdminMessage(messageText, { parse_mode: 'HTML' });

    this.logWebhookProcessed('GitLab', 'push', {
      projectId,
      branch,
      commitsCount,
      filesCount,
    });
  };
}
