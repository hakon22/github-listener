import { Octokit } from '@octokit/rest';
import { Container, Singleton } from 'typescript-ioc';

import type { ScmChangeInterface } from '@/interfaces/scm-change.interface';
import { ScmChangeBuilderService } from '@/services/scm/scm-change-builder.service';
import {
  API_REQUEST_TIMEOUT_MS,
  createFetchWithTimeout,
  createRateLimiter,
  DELAY_BETWEEN_REQUESTS_MS,
} from '@/utils/api-request.utils';

@Singleton
export class GithubAgent {
  private readonly scmChangeBuilderService = Container.get(ScmChangeBuilderService);

  private readonly requestDelay = createRateLimiter(DELAY_BETWEEN_REQUESTS_MS);

  private readonly octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN,
    baseUrl: process.env.GITHUB_API_URL,
    request: {
      fetch: createFetchWithTimeout(API_REQUEST_TIMEOUT_MS),
    },
  });

  private static readonly COMPARE_RETRY_DELAY_MS = 2000;

  public getPushChanges = async (owner: string, repositoryName: string, beforeSha: string, afterSha: string, paths: string[]): Promise<ScmChangeInterface[]> => {
    if (!owner || !repositoryName) {
      throw new Error('Owner or repositoryName is not provided');
    }

    const fetchCompare = () => this.octokit.repos.compareCommits({
      owner,
      repo: repositoryName,
      base: beforeSha,
      head: afterSha,
    });

    await this.requestDelay();
    let response: Awaited<ReturnType<typeof fetchCompare>>;
    try {
      response = await fetchCompare();
    } catch (error) {
      const err = error as { status?: number; response?: { status?: number } };
      const status = err.status ?? err.response?.status;
      if (typeof status === 'number' && status >= 500 && status < 600) {
        await new Promise((resolve) => setTimeout(resolve, GithubAgent.COMPARE_RETRY_DELAY_MS));
        response = await fetchCompare();
      } else {
        throw error;
      }
    }

    const { data } = response;
    const files = data.files ?? [];

    const addedPaths = new Set(
      files.filter((file) => file.status === 'added' && file.filename).map((file) => file.filename!),
    );
    const removedPaths = new Set(
      files.filter((file) => file.status === 'removed' && file.filename).map((file) => file.filename!),
    );

    const diffByPath = new Map<string, string>();
    for (const file of files) {
      if (!file.filename) {
        continue;
      }
      diffByPath.set(file.filename, file.patch ?? '');
    }

    return this.scmChangeBuilderService.buildPushChanges(
      paths,
      (filePath) => addedPaths.has(filePath)
        ? Promise.resolve('')
        : this.getFileContent(owner, repositoryName, filePath, beforeSha),
      (filePath) => removedPaths.has(filePath)
        ? Promise.resolve('')
        : this.getFileContent(owner, repositoryName, filePath, afterSha),
      diffByPath,
    );
  };

  public getPullRequestChanges = async (owner: string, repositoryName: string, pullRequestNumber: number): Promise<ScmChangeInterface[]> => {
    if (!owner || !repositoryName) {
      throw new Error('Owner or repositoryName is not provided');
    }

    await this.requestDelay();
    const { data: files } = await this.octokit.pulls.listFiles({
      owner,
      repo: repositoryName,
      pull_number: pullRequestNumber,
      per_page: 100,
    });

    return Promise.all(
      files.map(async (file): Promise<ScmChangeInterface> => {
        const filePath = file.filename;

        const newContent = await this.getFileContent(owner, repositoryName, filePath, 'HEAD');

        return {
          file: filePath,
          oldContent: '',
          newContent,
          diff: file.patch ?? '',
        };
      }),
    );
  };

  public getFilesSnapshot = async (owner: string, repositoryName: string, ref: string, paths: string[]): Promise<ScmChangeInterface[]> => {
    if (!owner || !repositoryName) {
      throw new Error('Owner or repositoryName is not provided');
    }

    const result = await this.scmChangeBuilderService.buildSnapshotChanges(
      paths,
      (filePath) => this.getFileContentAtRef(owner, repositoryName, filePath, ref),
    );

    return result;
  };

  public getRepositorySourceFilePaths = async (
    owner: string,
    repositoryName: string,
    ref: string,
    options?: { pathPrefix?: string; maxFiles?: number; },
  ): Promise<string[]> => {
    if (!owner || !repositoryName) {
      throw new Error('Owner or repositoryName is not provided');
    }

    await this.requestDelay();
    const { data: commit } = await this.octokit.repos.getCommit({
      owner,
      repo: repositoryName,
      ref,
    });

    const treeSha = commit.commit.tree.sha;

    await this.requestDelay();
    const { data: tree } = await this.octokit.git.getTree({
      owner,
      repo: repositoryName,
      tree_sha: treeSha,
      recursive: 'true',
    });

    const sourceExtensions = ['.ts', '.tsx', '.js', '.jsx', '.html'];
    const pathPrefix = options?.pathPrefix ?? '';
    const maxFiles = options?.maxFiles ?? 200;

    const paths: string[] = [];

    for (const item of tree.tree ?? []) {
      if (item.type !== 'blob' || !item.path) {
        continue;
      }
      const hasSourceExtension = sourceExtensions.some((extension) => item.path!.toLowerCase().endsWith(extension));
      if (!hasSourceExtension) {
        continue;
      }
      if (pathPrefix && !item.path.startsWith(pathPrefix)) {
        continue;
      }
      paths.push(item.path);
      if (paths.length >= maxFiles) {
        break;
      }
    }

    return paths;
  };

  public getFileContentAtRef = async (
    owner: string,
    repositoryName: string,
    filePath: string,
    ref: string,
  ): Promise<string> => this.getFileContent(owner, repositoryName, filePath, ref);

  private getFileContent = async (owner: string, repositoryName: string, filePath: string, ref: string): Promise<string> => {
    if (!owner || !repositoryName) {
      throw new Error('Owner or repositoryName is not provided');
    }

    try {
      await this.requestDelay();
      const { data } = await this.octokit.repos.getContent({
        owner,
        repo: repositoryName,
        path: filePath,
        ref,
      });

      if (!('content' in data) || typeof data.content !== 'string') {
        return '';
      }

      return Buffer.from(data.content, 'base64').toString();
    } catch {
      return '';
    }
  };
}
