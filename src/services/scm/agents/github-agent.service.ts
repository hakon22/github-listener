import { Octokit } from '@octokit/rest';
import { Container, Singleton } from 'typescript-ioc';

import type { ScmChangeInterface } from '@/interfaces/scm-change.interface';
import { ScmChangeBuilderService } from '@/services/scm/scm-change-builder.service';

@Singleton
export class GithubAgent {
  private readonly scmChangeBuilderService = Container.get(ScmChangeBuilderService);

  private readonly octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN,
    baseUrl: process.env.GITHUB_API_URL,
  });

  public getPushChanges = async (owner: string, repositoryName: string, beforeSha: string, afterSha: string, paths: string[]): Promise<ScmChangeInterface[]> => {
    if (!owner || !repositoryName) {
      throw new Error('Owner or repositoryName is not provided');
    }

    const { data } = await this.octokit.repos.compareCommits({
      owner,
      repo: repositoryName,
      base: beforeSha,
      head: afterSha,
    });

    const files = data.files ?? [];

    const diffByPath = new Map<string, string>();
    for (const file of files) {
      if (!file.filename) {
        continue;
      }
      diffByPath.set(file.filename, file.patch ?? '');
    }

    return this.scmChangeBuilderService.buildPushChanges(
      paths,
      (filePath) => this.getFileContent(owner, repositoryName, filePath, beforeSha),
      (filePath) => this.getFileContent(owner, repositoryName, filePath, afterSha),
      diffByPath,
    );
  };

  public getPullRequestChanges = async (owner: string, repositoryName: string, pullRequestNumber: number): Promise<ScmChangeInterface[]> => {
    if (!owner || !repositoryName) {
      throw new Error('Owner or repositoryName is not provided');
    }

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

    const { data: commit } = await this.octokit.repos.getCommit({
      owner,
      repo: repositoryName,
      ref,
    });

    const treeSha = commit.commit.tree.sha;

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
