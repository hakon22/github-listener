import type { Request, Response } from 'express';
import { Container, Singleton } from 'typescript-ioc';

import { BaseService } from '@/services/core/base.service';
import { GitlabAgentService } from '@/services/scm/agents/gitlab-agent.service';
import { ScmReviewService } from '@/services/scm/scm-review.service';
import { ScmNotificationService } from '@/services/scm/scm-notification.service';

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
  private readonly gitlabAgentService = Container.get(GitlabAgentService);

  private readonly scmReviewService = Container.get(ScmReviewService);

  private readonly scmNotificationService = Container.get(ScmNotificationService);

  public onWebhookMessage = (req: Request, res: Response): Response => {
    try {
      const eventKind = (req.body as { object_kind?: string; } | undefined)?.object_kind;

      if (eventKind === 'merge_request') {
        this.defer(() => this.handleMergeRequest(req.body as GitlabMergeRequestEvent));
      } else if (eventKind === 'push') {
        this.defer(() => this.handlePush(req.body as GitlabPushEvent));
      }

      return res.status(200).json({ status: 'processing' });
    } catch (error) {
      return this.handleWebhookProcessingError('GitLab', error, res);
    }
  };

  private handleMergeRequest = async (event: GitlabMergeRequestEvent): Promise<void> => {
    const projectId = event.project.id;
    const mergeRequestIid = event.object_attributes.iid;

    const changes = await this.gitlabAgentService.getMergeRequestChanges(projectId, mergeRequestIid);
    const recommendations = await this.scmReviewService.getRecommendationsForChanges(changes);

    await this.gitlabAgentService.addComments(projectId, mergeRequestIid, recommendations);
  };

  private handlePush = async (event: GitlabPushEvent): Promise<void> => {
    const projectId = event.project.id;
    const projectName = event.project.path_with_namespace
      || event.project.name
      || `ID ${projectId}`;

    const branch = event.ref.replace(/^refs\/heads\//, '');
    const author = event.user_name || event.user_username || 'неизвестен';

    const commits = event.commits ?? [];
    const commitsCount = event.total_commits_count ?? commits.length;

    const changedFiles = this.scmReviewService.collectChangedFiles(commits);
    const filesCount = changedFiles.size;
    let analysisSummary = '';
    let humanSummary = '';

    try {
      if (filesCount > 0) {
        const changedPaths = Array.from(changedFiles);

        const changes = event.before && event.after
          ? await this.gitlabAgentService.getPushChanges(
            projectId,
            event.before,
            event.after,
            changedPaths,
          )
          : await this.gitlabAgentService.getFilesSnapshot(
            projectId,
            branch,
            changedPaths,
          );

        const analysisResult = await this.scmReviewService.analyzeAndSummarizeChanges(
          changes,
          commits.map((commit) => ({
            id: commit.id,
            message: commit.message,
            files: [
              ...(commit.added ?? []),
              ...(commit.modified ?? []),
              ...(commit.removed ?? []),
            ],
          })),
          '<b>Результаты анализа кода</b>',
        );

        analysisSummary = analysisResult.analysisSummary;
        humanSummary = analysisResult.humanSummary;
      }
    } catch (error) {
      const errorInstance = error as Error;
      this.loggerService.error('Failed to analyze code for push event', {
        error: {
          name: errorInstance?.name || String(error),
          message: errorInstance?.message || String(error),
          stack: errorInstance?.stack,
        },
      });

      analysisSummary = this.scmReviewService.buildAnalysisErrorSummary(error);
    }

    const commitsSummary = this.scmReviewService.buildCommitsSummary(commits);

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
