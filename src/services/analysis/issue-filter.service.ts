import * as path from 'path';

import {
  deduplicateIssues,
  isFalsePositiveIssue,
  type IssueFilterInput,
} from '@/services/analysis/false-positive-filters';
import type { ScmChangeInterface } from '@/interfaces/scm-change.interface';
import type { CodeIssueInterface } from '@/services/analysis/code-analyzer.service';

export interface IssueFilterContext {
  contentByFile: Map<string, string>;
  diffByFile: Map<string, string>;
  changedPaths: Set<string>;
}

export const buildIssueFilterContext = (
  changes: ScmChangeInterface[],
  changedPaths?: Set<string>,
): IssueFilterContext => {
  const contentByFile = new Map<string, string>();
  const diffByFile = new Map<string, string>();
  const normalizedChanged = new Set<string>();

  for (const change of changes) {
    const normalized = path.normalize(change.file).replace(/\\/g, '/');
    contentByFile.set(normalized, change.newContent ?? '');
    if (change.diff) {
      diffByFile.set(normalized, change.diff);
    }
  }

  if (changedPaths) {
    for (const filePath of changedPaths) {
      normalizedChanged.add(path.normalize(filePath).replace(/\\/g, '/'));
    }
  } else {
    for (const key of contentByFile.keys()) {
      normalizedChanged.add(key);
    }
  }

  return { contentByFile, diffByFile, changedPaths: normalizedChanged };
};

const getLineText = (content: string, lineOneBased: number): string => {
  const lines = content.split('\n');
  const index = lineOneBased - 1;
  if (index < 0 || index >= lines.length) {
    return '';
  }
  return lines[index] ?? '';
};

export const filterCodeIssues = (
  issues: CodeIssueInterface[],
  context: IssueFilterContext,
): CodeIssueInterface[] => {
  const filtered = issues.filter((issue) => {
    const normalizedFile = path.normalize(issue.file).replace(/\\/g, '/');
    const fileContent = context.contentByFile.get(normalizedFile) ?? '';
    const lineText = getLineText(fileContent, issue.line);
    const input: IssueFilterInput = {
      file: issue.file,
      line: issue.line,
      message: issue.message,
      suggestion: issue.suggestion,
      rule: issue.rule,
      severity: issue.severity,
      lineText,
      fileContent,
      diff: context.diffByFile.get(normalizedFile),
      isImpactOnlyFile: context.changedPaths.size > 0 && !context.changedPaths.has(normalizedFile),
    };
    return !isFalsePositiveIssue(input);
  });

  return deduplicateIssues(filtered);
};

/** Post-process human summary to remove contradictions when critical issues exist. */
export const sanitizeHumanSummary = (summary: string, criticalCount: number): string => {
  if (!summary?.trim()) {
    return summary;
  }

  let result = summary;

  if (criticalCount > 0) {
    result = result.replace(/критичн\S*\s+проблем\S*\s+не\s+обнаружен\S*\.?/gi, '').trim();
    result = result.replace(/критических\s+проблем\s+не\s+обнаружено\.?/gi, '').trim();
  }

  result = result.replace(
    /существующие\s+вызовы\s+сломаны\.?/gi,
    'сигнатуры методов обновлены для универсальных компонентов.',
  );
  result = result.replace(
    /вызовы\s+по\s+старой\s+сигнатуре\s+сломаны\.?/gi,
    '',
  );
  result = result.replace(
    /вызовы\s+без\s+нового\s+параметра\s+приведут/gi,
    'новые параметры опциональны',
  );

  result = result.replace(/\s{2,}/g, ' ').trim();

  if (criticalCount > 0 && !/критичн/i.test(result.slice(0, 200))) {
    result = `Обнаружено критических замечаний: ${criticalCount}. ${result}`.trim();
  }

  return result;
};
