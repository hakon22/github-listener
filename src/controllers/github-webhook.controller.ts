import { Container, Singleton } from 'typescript-ioc';
import { Webhooks } from '@octokit/webhooks';
import type { Request, Response } from 'express';
import type { PushEvent, PullRequestEvent } from '@octokit/webhooks-types';

import { BaseService } from '@/services/core/base.service';
import { GithubAgent } from '@/services/scm/agents/github-agent.service';
import { ScmReviewService } from '@/services/scm/scm-review.service';
import { ScmNotificationService } from '@/services/scm/scm-notification.service';
import { ScmPushAnalysisService } from '@/services/scm/scm-push-analysis.service';

type GithubPushEvent = PushEvent;

type GithubPullRequestEvent = PullRequestEvent;

@Singleton
export class GithubWebhookController extends BaseService {
  protected override readonly TAG: string = 'GithubWebhookController';

  private readonly githubAgent = Container.get(GithubAgent);

  private readonly scmPushAnalysisService = Container.get(ScmPushAnalysisService);

  private readonly scmReviewService = Container.get(ScmReviewService);

  private readonly scmNotificationService = Container.get(ScmNotificationService);

  private readonly webhooks = new Webhooks({
    secret: process.env.GITHUB_SECRET ?? '',
  });

  public onWebhookMessage = async (req: Request, res: Response): Promise<Response> => {
    try {
      const eventName = req.headers['x-github-event'] as string | undefined;
      const signature = req.headers['x-hub-signature-256'] as string;

      this.loggerService.info(this.TAG, `Received GitHub webhook: event=${eventName ?? 'unknown'}`);

      const verified = await this.webhooks.verify(JSON.stringify(req.body), signature);
      if (!verified) {
        this.loggerService.warn(this.TAG, 'GitHub webhook signature verification failed');
        return res.status(401).json({ status: 'unauthorized' });
      }

      if (eventName === 'push') {
        this.defer(() => this.handlePush(req.body as GithubPushEvent));
      } else if (eventName === 'pull_request') {
        this.defer(() => this.handlePullRequest(req.body as GithubPullRequestEvent));
      } else {
        this.loggerService.debug(this.TAG, `Ignored GitHub event: ${eventName}`);
      }

      return res.status(200).json({ status: 'processing' });
    } catch (error) {
      return this.handleWebhookProcessingError('GitHub', error, res);
    }
  };

  private handlePush = async (event: GithubPushEvent): Promise<void> => {
    const repositoryId = event.repository.id;
    const repositoryOwner = event.repository.owner?.login
      || event.repository.owner?.name
      || '';
    const repositoryName = event.repository.full_name
      || event.repository.name
      || `ID ${repositoryId}`;

    const branch = event.ref.replace(/^refs\/heads\//, '');
    const author = event.pusher?.name || event.sender?.login || 'unknown';

    this.loggerService.info(this.TAG, `Processing GitHub push: repo=${repositoryName}, branch=${branch}, author=${author}`);

    const commits = event.commits ?? [];
    const commitsCount = commits.length;

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
            ? this.githubAgent.getPushChanges(
              repositoryOwner,
              event.repository.name,
              event.before,
              event.after,
              changedPaths,
            )
            : this.githubAgent.getFilesSnapshot(
              repositoryOwner,
              event.repository.name,
              branch,
              changedPaths,
            )),
          getSnapshot: (paths) => this.githubAgent.getFilesSnapshot(
            repositoryOwner,
            event.repository.name,
            ref,
            paths,
          ),
          getAffectedPathsInput: () => ({
            getSourceFilePaths: () => this.githubAgent.getRepositorySourceFilePaths(
              repositoryOwner,
              event.repository.name,
              ref,
              { maxFiles: 200 },
            ),
            getSourceFilePathsForEntityUsage: () => this.githubAgent.getRepositorySourceFilePaths(
              repositoryOwner,
              event.repository.name,
              ref,
              { maxFiles: 500 },
            ),
            getFileContent: (filePath) => this.githubAgent.getFileContentAtRef(
              repositoryOwner,
              event.repository.name,
              filePath,
              ref,
            ),
          }),
        },
        changedPaths,
        commits: commits.map((commit: GithubPushEvent['commits'][number]) => ({
          id: commit.id,
          message: commit.message,
          files: [
            ...(commit.added ?? []),
            ...(commit.modified ?? []),
            ...(commit.removed ?? []),
          ],
        })),
        summaryTitle: '<b>Результаты анализа кода</b>',
        errorContext: 'Failed to analyze code for GitHub push event',
      });

      analysisSummary = pushResult.analysisSummary;
      humanSummary = pushResult.humanSummary;
      commitsSummary = pushResult.commitsSummary;
    } else {
      commitsSummary = this.scmReviewService.buildCommitsSummary(commits);
    }

    const text = this.scmNotificationService.buildPushNotificationText({
      providerName: 'GitHub',
      targetLabel: 'Репозиторий',
      targetName: this.scmReviewService.escapeHtml(repositoryName),
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

    await this.telegramService.sendAdminMessage(text, { parse_mode: 'HTML' });

    this.logWebhookProcessed('GitHub', 'push', {
      repositoryId,
      branch,
      commitsCount,
      filesCount,
    });
  };

  private handlePullRequest = async (event: GithubPullRequestEvent): Promise<void> => {
    const repositoryId = event.repository.id;
    const repositoryOwner = event.repository.owner?.login
      || event.repository.owner?.name
      || '';
    const repositoryName = event.repository.full_name
      || event.repository.name
      || `ID ${repositoryId}`;

    const pullRequestNumber = event.pull_request.number;
    const pullRequestTitle = event.pull_request.title ?? '';
    const pullRequestUrl = event.pull_request.html_url ?? '';

    const author = event.sender?.login || 'unknown';

    this.loggerService.info(this.TAG, `Processing GitHub pull_request: repo=${repositoryName}, PR #${pullRequestNumber}, author=${author}`);

    const ref = event.pull_request.head.sha;
    const pushResult = await this.scmPushAnalysisService.run({
      driver: {
        getInitialChanges: () => this.githubAgent.getPullRequestChanges(
          repositoryOwner,
          event.repository.name,
          pullRequestNumber,
        ),
        getSnapshot: (paths) => this.githubAgent.getFilesSnapshot(
          repositoryOwner,
          event.repository.name,
          ref,
          paths,
        ),
        getAffectedPathsInput: () => ({
          getSourceFilePaths: () => this.githubAgent.getRepositorySourceFilePaths(
            repositoryOwner,
            event.repository.name,
            ref,
            { maxFiles: 200 },
          ),
          getSourceFilePathsForEntityUsage: () => this.githubAgent.getRepositorySourceFilePaths(
            repositoryOwner,
            event.repository.name,
            ref,
            { maxFiles: 500 },
          ),
          getFileContent: (filePath) => this.githubAgent.getFileContentAtRef(
            repositoryOwner,
            event.repository.name,
            filePath,
            ref,
          ),
        }),
      },
      changedPaths: [], // будут получены из getInitialChanges внутри run
      commits: [],
      summaryTitle: '<b>Результаты анализа кода по Pull Request</b>',
      errorContext: 'Failed to analyze code for GitHub pull_request event',
    });

    const text = this.scmNotificationService.buildPullRequestNotificationText({
      providerName: 'GitHub',
      repositoryName: this.scmReviewService.escapeHtml(repositoryName),
      pullRequestNumber,
      pullRequestTitle: this.scmReviewService.escapeHtml(pullRequestTitle),
      pullRequestUrl: this.scmReviewService.escapeHtml(pullRequestUrl),
      author: this.scmReviewService.escapeHtml(author),
      humanSummary: this.scmReviewService.escapeHtml(pushResult.humanSummary),
      analysisSummary: pushResult.analysisSummary,
      processedFilesCount: pushResult.processedFilesCount,
      processedFilePaths: pushResult.processedFilePaths,
    });

    await this.telegramService.sendAdminMessage(text, { parse_mode: 'HTML' });

    this.logWebhookProcessed('GitHub', 'pull_request', {
      repositoryId,
      pullRequestNumber,
    });
  };
}

