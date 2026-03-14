import { Container, Singleton } from 'typescript-ioc';
import { Webhooks } from '@octokit/webhooks';
import type { Request, Response } from 'express';
import type { PushEvent, PullRequestEvent } from '@octokit/webhooks-types';

import { BaseService } from '@/services/core/base.service';
import { AffectedFilesService } from '@/services/analysis/affected-files.service';
import { GithubAgent } from '@/services/scm/agents/github-agent.service';
import { ScmReviewService } from '@/services/scm/scm-review.service';
import { ScmNotificationService } from '@/services/scm/scm-notification.service';

type GithubPushEvent = PushEvent;

type GithubPullRequestEvent = PullRequestEvent;

@Singleton
export class GithubWebhookController extends BaseService {
  private readonly affectedFilesService = Container.get(AffectedFilesService);

  private readonly githubAgent = Container.get(GithubAgent);

  private readonly scmReviewService = Container.get(ScmReviewService);

  private readonly scmNotificationService = Container.get(ScmNotificationService);

  private readonly webhooks = new Webhooks({
    secret: process.env.GITHUB_SECRET ?? '',
  });

  public onWebhookMessage = async (req: Request, res: Response): Promise<Response> => {
    try {
      const eventName = req.headers['x-github-event'] as string | undefined;
      const signature = req.headers['x-hub-signature-256'] as string;

      const verified = await this.webhooks.verify(JSON.stringify(req.body), signature);
      if (!verified) {
        return res.status(401).json({ status: 'unauthorized' });
      }

      if (eventName === 'push') {
        this.defer(() => this.handlePush(req.body as GithubPushEvent));
      } else if (eventName === 'pull_request') {
        this.defer(() => this.handlePullRequest(req.body as GithubPullRequestEvent));
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

    const commits = event.commits ?? [];
    const commitsCount = commits.length;

    const changedFiles = this.scmReviewService.collectChangedFiles(commits);
    const filesCount = changedFiles.size;

    let analysisSummary = '';
    let humanSummary = '';

    try {
      if (filesCount > 0) {
        const changedPaths = Array.from(changedFiles);
        const ref = event.after ?? branch;

        const changes = event.before && event.after
          ? await this.githubAgent.getPushChanges(
            repositoryOwner,
            event.repository.name,
            event.before,
            event.after,
            changedPaths,
          )
          : await this.githubAgent.getFilesSnapshot(
            repositoryOwner,
            event.repository.name,
            branch,
            changedPaths,
          );

        let mergedChanges = changes;

        if (process.env.IMPACT_ANALYSIS_ENABLED !== 'false') {
          try {
            const affectedPaths = await this.affectedFilesService.getAffectedPaths(
              changedPaths,
              {
                getSourceFilePaths: () => this.githubAgent.getRepositorySourceFilePaths(
                  repositoryOwner,
                  event.repository.name,
                  ref,
                  { maxFiles: 200 },
                ),
                getFileContent: (filePath) => this.githubAgent.getFileContentAtRef(
                  repositoryOwner,
                  event.repository.name,
                  filePath,
                  ref,
                ),
              },
              { affectedFileLimit: 50 },
            );

            const changedSet = new Set(changedPaths);
            const pathsToFetch = affectedPaths.filter((filePath) => !changedSet.has(filePath));

            if (pathsToFetch.length > 0) {
              const affectedChanges = await this.githubAgent.getFilesSnapshot(
                repositoryOwner,
                event.repository.name,
                ref,
                pathsToFetch,
              );
              mergedChanges = [...changes, ...affectedChanges];
            }
          } catch {
            // fallback: analyze only changed files
          }
        }

        const analysisResult = await this.scmReviewService.analyzeAndSummarizeChanges(
          mergedChanges,
          commits.map((commit: GithubPushEvent['commits'][number]) => ({
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
      this.loggerService.error('Failed to analyze code for GitHub push event', {
        error: {
          name: errorInstance?.name || String(error),
          message: errorInstance?.message || String(error),
          stack: errorInstance?.stack,
        },
      });

      analysisSummary = this.scmReviewService.buildAnalysisErrorSummary(error);
    }

    const commitsSummary = this.scmReviewService.buildCommitsSummary(commits);

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

    let analysisSummary = '';
    let humanSummary = '';

    try {
      const changes = await this.githubAgent.getPullRequestChanges(
        repositoryOwner,
        event.repository.name,
        pullRequestNumber,
      );

      let mergedChanges = changes;
      const ref = event.pull_request.head.sha;

      if (process.env.IMPACT_ANALYSIS_ENABLED !== 'false' && changes.length > 0) {
        try {
          const changedPaths = changes.map((change) => change.file);
          const affectedPaths = await this.affectedFilesService.getAffectedPaths(
            changedPaths,
            {
              getSourceFilePaths: () => this.githubAgent.getRepositorySourceFilePaths(
                repositoryOwner,
                event.repository.name,
                ref,
                { maxFiles: 200 },
              ),
              getFileContent: (filePath) => this.githubAgent.getFileContentAtRef(
                repositoryOwner,
                event.repository.name,
                filePath,
                ref,
              ),
            },
            { affectedFileLimit: 50 },
          );

          const changedSet = new Set(changedPaths);
          const pathsToFetch = affectedPaths.filter((filePath) => !changedSet.has(filePath));

          if (pathsToFetch.length > 0) {
            const affectedChanges = await this.githubAgent.getFilesSnapshot(
              repositoryOwner,
              event.repository.name,
              ref,
              pathsToFetch,
            );
            mergedChanges = [...changes, ...affectedChanges];
          }
        } catch {
          // fallback: analyze only changed files
        }
      }

      const analysisResult = await this.scmReviewService.analyzeAndSummarizeChanges(
        mergedChanges,
        [],
        '<b>Результаты анализа кода по Pull Request</b>',
      );

      analysisSummary = analysisResult.analysisSummary;
      humanSummary = analysisResult.humanSummary;
    } catch (error) {
      const errorInstance = error as Error;
      this.loggerService.error('Failed to analyze code for GitHub pull_request event', {
        error: {
          name: errorInstance?.name || String(error),
          message: errorInstance?.message || String(error),
          stack: errorInstance?.stack,
        },
      });

      analysisSummary = this.scmReviewService.buildAnalysisErrorSummary(error);
    }

    const text = this.scmNotificationService.buildPullRequestNotificationText({
      providerName: 'GitHub',
      repositoryName: this.scmReviewService.escapeHtml(repositoryName),
      pullRequestNumber,
      pullRequestTitle: this.scmReviewService.escapeHtml(pullRequestTitle),
      pullRequestUrl: this.scmReviewService.escapeHtml(pullRequestUrl),
      author: this.scmReviewService.escapeHtml(author),
      humanSummary: this.scmReviewService.escapeHtml(humanSummary),
      analysisSummary,
    });

    await this.telegramService.sendAdminMessage(text, { parse_mode: 'HTML' });

    this.logWebhookProcessed('GitHub', 'pull_request', {
      repositoryId,
      pullRequestNumber,
    });
  };
}

