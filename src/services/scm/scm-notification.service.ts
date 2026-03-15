import { Singleton } from 'typescript-ioc';

interface PushNotificationParamsInterface {
  providerName: 'GitHub' | 'GitLab';
  targetLabel: 'Репозиторий' | 'Проект';
  targetName: string;
  branch: string;
  author: string;
  commitsCount: number;
  filesCount: number;
  humanSummary: string;
  commitsSummary: string;
  analysisSummary: string;
  processedFilesCount?: number;
  processedFilePaths?: string[];
}

interface PullRequestNotificationParamsInterface {
  providerName: 'GitHub';
  repositoryName: string;
  pullRequestNumber: number;
  pullRequestTitle: string;
  pullRequestUrl: string;
  author: string;
  humanSummary: string;
  analysisSummary: string;
  processedFilesCount?: number;
  processedFilePaths?: string[];
}

@Singleton
export class ScmNotificationService {
  public buildPushNotificationText = (params: PushNotificationParamsInterface): string => {
    const textLines: string[] = [
      `<b>${params.providerName} push обработан</b>`,
      '',
      `${params.targetLabel}: <b>${params.targetName}</b>`,
      `Ветка: <code>${params.branch}</code>`,
      `Автор: <b>${params.author}</b>`,
      `Коммитов: <b>${params.commitsCount}</b>`,
      `Затронуто файлов: <b>${params.filesCount}</b>`,
    ];

    if (params.processedFilesCount !== undefined && params.processedFilesCount > 0) {
      textLines.push(`Обработано моделью: <b>${params.processedFilesCount}</b> файлов`);
      if (params.processedFilePaths && params.processedFilePaths.length < 10) {
        const escapedPaths = params.processedFilePaths.map((filePath) => `<code>${filePath.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/&/g, '&amp;')}</code>`);
        textLines.push(escapedPaths.join('\n'));
      }
    }

    if (params.humanSummary) {
      textLines.push('', `<b>Суть изменений:</b> ${params.humanSummary}`);
    }

    if (params.commitsSummary) {
      textLines.push('', 'Кратко по коммитам:', params.commitsSummary);
    }

    if (params.analysisSummary) {
      textLines.push(params.analysisSummary);
    }

    return textLines.join('\n');
  };

  public buildPullRequestNotificationText = (params: PullRequestNotificationParamsInterface): string => {
    const textLines: string[] = [
      `<b>${params.providerName} pull request обработан</b>`,
      '',
      `Репозиторий: <b>${params.repositoryName}</b>`,
      `Pull Request: <b>#${params.pullRequestNumber}</b> ${params.pullRequestTitle}`,
      params.pullRequestUrl ? `Ссылка: ${params.pullRequestUrl}` : '',
      `Автор: <b>${params.author}</b>`,
    ].filter(Boolean);

    if (params.processedFilesCount !== undefined && params.processedFilesCount > 0) {
      textLines.push('', `Обработано моделью: <b>${params.processedFilesCount}</b> файлов`);
      if (params.processedFilePaths && params.processedFilePaths.length < 10) {
        const escapedPaths = params.processedFilePaths.map((filePath) => `<code>${filePath.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/&/g, '&amp;')}</code>`);
        textLines.push(escapedPaths.join('\n'));
      }
    }

    if (params.humanSummary) {
      textLines.push('', `<b>Суть изменений:</b> ${params.humanSummary}`);
    }

    if (params.analysisSummary) {
      textLines.push(params.analysisSummary);
    }

    return textLines.join('\n');
  };
}
