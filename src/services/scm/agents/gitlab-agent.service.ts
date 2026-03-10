import { Gitlab } from '@gitbeaker/rest';
import { Container, Singleton } from 'typescript-ioc';

import type { AICodeIssueRecommendation } from '@/services/analysis/ai.service';
import type { ScmChangeInterface } from '@/interfaces/scm-change.interface';
import { ScmChangeBuilderService } from '@/services/scm/scm-change-builder.service';

interface MergeRequestDiffItem {
  old_path?: string;
  new_path?: string;
  diff?: string;
}

interface RepositoryCompareResponse {
  diffs?: MergeRequestDiffItem[];
}

@Singleton
export class GitlabAgentService {
  private readonly scmChangeBuilderService = Container.get(ScmChangeBuilderService);

  private readonly gitlab: InstanceType<typeof Gitlab>;

  public constructor() {
    this.gitlab = new Gitlab({
      host: process.env.GITLAB_URL,
      token: process.env.GITLAB_TOKEN,
    });
  }

  public getMergeRequestChanges = async (projectId: number, mergeRequestIid: number): Promise<ScmChangeInterface[]> => {
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
    const compareResponse = await this.gitlab.Repositories.compare(projectId, before, after) as RepositoryCompareResponse;
    const diffs = compareResponse.diffs ?? [];

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
      (filePath) => this.getFileContent(projectId, filePath, before),
      (filePath) => this.getFileContent(projectId, filePath, after),
      diffByPath,
    );
  };

  public getFilesSnapshot = async (projectId: number, ref: string, paths: string[]): Promise<ScmChangeInterface[]> => {
    const changes = await this.scmChangeBuilderService.buildSnapshotChanges(
      paths,
      (filePath) => this.getFileContent(projectId, filePath, ref),
    );

    return changes;
  };

  public addComments = async (
    projectId: number,
    mergeRequestIid: number,
    recommendations: AICodeIssueRecommendation[],
  ): Promise<void> => {
    for (const recommendation of recommendations) {
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
      const content = await this.gitlab.RepositoryFiles.show(projectId, filePath, ref);
      return Buffer.from(content.content, 'base64').toString();
    } catch {
      return '';
    }
  };
}
