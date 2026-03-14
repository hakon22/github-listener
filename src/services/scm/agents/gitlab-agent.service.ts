import { Gitlab } from '@gitbeaker/rest';
import { Container, Singleton } from 'typescript-ioc';

import type { AICodeIssueRecommendation } from '@/services/analysis/ai.service';
import type { ScmChangeInterface } from '@/interfaces/scm-change.interface';
import { ScmChangeBuilderService } from '@/services/scm/scm-change-builder.service';
import { createRateLimiter, DELAY_BETWEEN_REQUESTS_MS } from '@/utils/api-request.utils';

interface MergeRequestDiffItem {
  old_path?: string;
  new_path?: string;
  diff?: string;
}

interface RepositoryCompareResponse {
  diffs?: MergeRequestDiffItem[];
}

const COMPARE_RETRY_DELAY_MS = 2000;

@Singleton
export class GitlabAgentService {
  private readonly scmChangeBuilderService = Container.get(ScmChangeBuilderService);

  private readonly requestDelay = createRateLimiter(DELAY_BETWEEN_REQUESTS_MS);

  private readonly gitlab: InstanceType<typeof Gitlab>;

  public constructor() {
    this.gitlab = new Gitlab({
      host: process.env.GITLAB_URL,
      token: process.env.GITLAB_TOKEN,
    });
  }

  public getMergeRequestChanges = async (projectId: number, mergeRequestIid: number): Promise<ScmChangeInterface[]> => {
    await this.requestDelay();
    const diffs = await this.gitlab.MergeRequests.allDiffs(projectId, mergeRequestIid, { perPage: 100 });

    return Promise.all(
      (diffs as MergeRequestDiffItem[]).map(async (item) => {
        const filePath = item.new_path ?? item.old_path ?? '';

        return {
          file: filePath,
          oldContent: item.old_path ? await this.getFileContent(projectId, item.old_path) : '',
          newContent: item.new_path ? await this.getFileContent(projectId, item.new_path) : '',
          diff: item.diff ?? '',
        };
      }),
    );
  };

  public getPushChanges = async (
    projectId: number,
    before: string,
    after: string,
    paths: string[],
  ): Promise<ScmChangeInterface[]> => {
    const fetchCompare = () => this.gitlab.Repositories.compare(projectId, before, after) as Promise<RepositoryCompareResponse>;

    await this.requestDelay();
    let compareResponse: RepositoryCompareResponse;
    try {
      compareResponse = await fetchCompare();
    } catch (error) {
      const err = error as { response?: { status?: number }; status?: number };
      const status = err.status ?? err.response?.status;
      if (typeof status === 'number' && status >= 500 && status < 600) {
        await new Promise((resolve) => setTimeout(resolve, COMPARE_RETRY_DELAY_MS));
        compareResponse = await fetchCompare();
      } else {
        throw error;
      }
    }

    const diffs = compareResponse.diffs ?? [];

    const addedPaths = new Set(
      diffs.filter((item) => !item.old_path && item.new_path).map((item) => item.new_path!),
    );
    const removedPaths = new Set(
      diffs.filter((item) => item.old_path && !item.new_path).map((item) => item.old_path!),
    );

    const diffByPath = new Map<string, string>();
    for (const item of diffs) {
      const patch = item.diff ?? '';

      if (item.new_path) {
        diffByPath.set(item.new_path, patch);
      }

      if (item.old_path && item.old_path !== item.new_path) {
        diffByPath.set(item.old_path, patch);
      }
    }

    return this.scmChangeBuilderService.buildPushChanges(
      paths,
      (filePath) => addedPaths.has(filePath)
        ? Promise.resolve('')
        : this.getFileContent(projectId, filePath, before),
      (filePath) => removedPaths.has(filePath)
        ? Promise.resolve('')
        : this.getFileContent(projectId, filePath, after),
      diffByPath,
    );
  };

  public getFilesSnapshot = async (projectId: number, ref: string, paths: string[]): Promise<ScmChangeInterface[]> => {
    const changes = await this.scmChangeBuilderService.buildSnapshotChanges(
      paths,
      (filePath) => this.getFileContentAtRef(projectId, filePath, ref),
    );

    return changes;
  };

  public getRepositorySourceFilePaths = async (
    projectId: number,
    ref: string,
    options?: { pathPrefix?: string; maxFiles?: number; },
  ): Promise<string[]> => {
    await this.requestDelay();
    const response = await this.gitlab.Repositories.allRepositoryTrees(projectId, {
      ref,
      recursive: true,
      perPage: options?.maxFiles ?? 200,
    });

    const data = Array.isArray(response) ? response : (response as { data?: { path?: string; type?: string }[] })?.data ?? response;
    const items = Array.isArray(data) ? data : [];

    const sourceExtensions = ['.ts', '.tsx', '.js', '.jsx', '.html'];
    const pathPrefix = options?.pathPrefix ?? '';
    const maxFiles = options?.maxFiles ?? 200;

    const paths: string[] = [];

    for (const item of items) {
      const pathValue = (item as { path?: string }).path ?? '';
      const typeValue = (item as { type?: string }).type ?? '';

      if (typeValue !== 'blob' || !pathValue) {
        continue;
      }
      const hasSourceExtension = sourceExtensions.some((extension) => pathValue.toLowerCase().endsWith(extension));
      if (!hasSourceExtension) {
        continue;
      }
      if (pathPrefix && !pathValue.startsWith(pathPrefix)) {
        continue;
      }
      paths.push(pathValue);
      if (paths.length >= maxFiles) {
        break;
      }
    }

    return paths;
  };

  public getFileContentAtRef = async (projectId: number, filePath: string, ref: string): Promise<string> =>
    this.getFileContent(projectId, filePath, ref);

  public addComments = async (
    projectId: number,
    mergeRequestIid: number,
    recommendations: AICodeIssueRecommendation[],
  ): Promise<void> => {
    for (const recommendation of recommendations) {
      await this.requestDelay();
      await this.gitlab.MergeRequestNotes.create(
        projectId,
        mergeRequestIid,
        this.formatComment(recommendation),
      );
    }
  };

  private formatComment(recommendation: AICodeIssueRecommendation): string {
    return `🤖 AI Code Review

File: ${recommendation.file}:${recommendation.line}
Rule: ${recommendation.rule}

Issue: ${recommendation.message}
Severity: ${recommendation.severity}
Type: ${recommendation.type}

Suggestion:
${recommendation.suggestion ?? ''}

${recommendation.codeExample ? `Fixed example:\n\`\`\`typescript\n${recommendation.codeExample}\n\`\`\`` : ''}`;
  }

  private getFileContent = async (projectId: number, filePath: string, ref = 'main'): Promise<string> => {
    try {
      await this.requestDelay();
      const content = await this.gitlab.RepositoryFiles.show(projectId, filePath, ref);
      return Buffer.from(content.content, 'base64').toString();
    } catch {
      return '';
    }
  };
}
