import {
  isLineOutsideDiffHunks,
  isMessageAboutRemovedDiffOnly,
  isRecommendationAlreadyApplied,
} from '@/services/analysis/diff-aware.utils';
import {
  isLineAfterEarlyReturnGuard,
  isLineCoherentWithMessage,
} from '@/services/analysis/issue-line-coherence';

export interface IssueFilterInput {
  file: string;
  line: number;
  message: string;
  suggestion?: string;
  rule?: string;
  type?: string;
  severity?: string;
  lineText: string;
  fileContent?: string;
  diff?: string;
  /** File was included only via impact analysis, not in the push changed paths */
  isImpactOnlyFile?: boolean;
}

const messageMatches = (message: string, patterns: RegExp[]): boolean =>
  patterns.some((pattern) => pattern.test(message));

/** Object.values(SomeEnum) — compile-time safe in TypeScript */
const isObjectValuesEnumFalsePositive = (lineText: string, message: string): boolean =>
  /Object\.values\s*\(\s*\w+Enum\s*\)/.test(lineText)
  && messageMatches(message, [/пустом\s+enum/i, /Object\.values/i, /enum/i]);

/** JSON.stringify already used for logging */
const isJsonStringifyLogFalsePositive = (lineText: string, message: string): boolean =>
  /JSON\.stringify\s*\(/.test(lineText)
  && messageMatches(message, [/сериализ/i, /JSON\.stringify/i, /логирован/i]);

/** .find((x) => x.prop) — x is the array element, not an outer variable */
const isCallbackShadowFalsePositive = (lineText: string, message: string): boolean => {
  const callbackMatch = lineText.match(/\.find\s*\(\s*\(\s*(\w+)\s*\)\s*=>/);
  if (!callbackMatch?.[1]) {
    return false;
  }
  const param = callbackMatch[1];
  if (!messageMatches(message, [
    new RegExp(`\\b${param}\\b`, 'i'),
    /undefined/i,
    /не\s+определ/i,
  ])) {
    return false;
  }
  return new RegExp(`\\(\\s*${param}\\s*\\)\\s*=>[^;]*\\b${param}\\.`).test(lineText);
};

/** Default parameter in signature — optional, does not break callers */
const isDefaultParameterFalsePositive = (lineText: string, message: string): boolean => {
  const hasDefault = /\(\s*[^)]*\w+\s*=\s*[^),]+/.test(lineText)
    || /\w+\s*=\s*false/.test(lineText)
    || /\?\s*:/.test(lineText);
  if (!hasDefault) {
    return false;
  }
  return messageMatches(message, [
    /обязательн/i,
    /сигнатур/i,
    /параметр/i,
    /Incorrect parameter/i,
    /вызов/i,
    /сломан/i,
    /без\s+нового\s+параметра/i,
  ]);
};

/** for (const [_, ident] of Object.entries(...)) — ident is always defined */
const isDestructuringForOfFalsePositive = (lineText: string, message: string): boolean =>
  /for\s*\(\s*const\s+\[[^\]]+\]\s+of\s+Object\.entries/.test(lineText)
  && messageMatches(message, [/undefined/i, /не\s+определ/i, /turnovers/i, /объект/i]);

/** i18n[key] ?? fallback */
const isI18nFallbackFalsePositive = (lineText: string, message: string): boolean =>
  /\]\s*\?\?\s*\w+/.test(lineText)
  && messageMatches(message, [/i18n/i, /перевод/i, /ключ/i, /EnumI18n/i]);

/** return value === true after reading query flag */
const isStrictBoolQueryFlagFalsePositive = (lineText: string): boolean =>
  /return\s+\w+\s*===\s*true\s*;?/.test(lineText);

/** Line already uses ?. or ?? for the property mentioned */
const hasGuardOnLine = (lineText: string): boolean =>
  /\?\./.test(lineText) || /\?\?/.test(lineText) || /\|\|\s*\{/.test(lineText);

/** parseFloat(x) || 0 — NaN guarded */
const isParseFloatWithFallbackFalsePositive = (lineText: string, message: string): boolean =>
  /parseFloat\s*\([^)]+\)\s*\|\|\s*0/.test(lineText)
  && messageMatches(message, [/NaN/i, /parseFloat/i, /undefined/i]);

/** Knex builder.toQuery() — not a missing table check issue */
const isKnexToQueryFalsePositive = (lineText: string, message: string): boolean =>
  /\.toQuery\s*\(\s*\)/.test(lineText)
  && messageMatches(message, [/таблиц/i, /колонок/i, /toQuery/i, /билдер/i]);

/** ESLint/style issues mislabeled as security */
const isNonRuntimeLintIssue = (lineText: string, message: string, suggestion?: string): boolean => {
  const combined = `${message} ${suggestion ?? ''}`;
  if (messageMatches(combined, [/избыточн/i, /тривиальн/i, /let\s+на\s+const/i, /prefer-const/i])) {
    return true;
  }
  if (/:\s*boolean\s*=\s*false/.test(lineText) && messageMatches(combined, [/boolean/i, /аннотац/i])) {
    return true;
  }
  if (/^\s*let\s+\w+\s*=\s*\[\]/.test(lineText) && messageMatches(combined, [/const/i, /let/i])) {
    return true;
  }
  if (/^\s*\}\s*;\s*$/.test(lineText.trim()) && messageMatches(combined, [/точк/i, /запят/i, /semicolon/i])) {
    return true;
  }
  if (messageMatches(combined, [/нет\s+прямого\s+рантайм/i, /стил/i, /нейминг/i])) {
    return true;
  }
  return false;
};

/** Double semicolon on import — compile-time */
const isDoubleSemicolonImportFalsePositive = (lineText: string): boolean =>
  /^\s*import\s+.+\s*;;\s*$/.test(lineText);

/** Empty async stub on feature branch — not a runtime crash */
const isEmptyAsyncStubFalsePositive = (lineText: string, message: string): boolean =>
  /=>\s*\{\s*\}\s*;?\s*$/.test(lineText)
  && messageMatches(message, [/пуст/i, /не\s+использу/i, /async/i]);

/** hasOwnProperty on params.required — theoretical, params is a typed config object */
const isHasOwnPropertyFalsePositive = (lineText: string, message: string): boolean =>
  /\.hasOwnProperty\s*\(/.test(lineText)
  && messageMatches(message, [/hasOwnProperty/i, /Object\.hasOwn/i]);

/** Missing validation on REST controller when decorators handle it */
const isRestDecoratorValidationFalsePositive = (
  lineText: string,
  message: string,
  fileContent?: string,
): boolean => {
  if (!messageMatches(message, [/валидац/i, /проверк/i, /DTO/i, /параметр/i, /undefined/i])) {
    return false;
  }

  if (/^\s*middlewares\s*:/.test(lineText) || /^\s*name\s*:\s*['"]/.test(lineText)) {
    return true;
  }

  if (!fileContent) {
    return false;
  }

  const lines = fileContent.split('\n');
  const lineIndex = lines.findIndex((line) => line === lineText);
  if (lineIndex === -1) {
    return false;
  }

  const windowStart = Math.max(0, lineIndex - 15);
  const windowEnd = Math.min(lines.length, lineIndex + 5);
  const window = lines.slice(windowStart, windowEnd).join('\n');

  return /@(?:Query|Body|Params)RestActionInjectDecorator/.test(window)
    || /RestActionInjectDecorator/.test(window);
};

/** Wrong argument copy-paste — keep if in added diff line (do NOT filter) */
const isWrongArgumentCopyPaste = (lineText: string, diff?: string): boolean => {
  const mismatch = /apply\w+Filter\s*\([^,]+,\s*options\?\.\w+Ids/.test(lineText);
  if (!mismatch || !diff) {
    return false;
  }
  const addedLines = diff.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++'));
  return addedLines.some((line) => line.includes(lineText.trim()));
};

/**
 * Returns true if the issue should be dropped as a false positive.
 */
export const isFalsePositiveIssue = (input: IssueFilterInput): boolean => {
  const { lineText, message, suggestion, fileContent, diff, isImpactOnlyFile } = input;
  const combinedMessage = `${message} ${suggestion ?? ''}`;

  if (isImpactOnlyFile) {
    return true;
  }

  if (diff && isMessageAboutRemovedDiffOnly(diff, lineText, message)) {
    return true;
  }

  if (isRecommendationAlreadyApplied(lineText, message, suggestion)) {
    return true;
  }

  if (
    diff
    && !isImpactOnlyFile
    && isLineOutsideDiffHunks(diff, input.line)
  ) {
    return true;
  }

  if (isWrongArgumentCopyPaste(lineText, diff)) {
    return false;
  }

  if (hasGuardOnLine(lineText) && messageMatches(combinedMessage, [/undefined/i, /TypeError/i, /свойств/i, /доступ/i])) {
    return true;
  }

  if (fileContent && isLineAfterEarlyReturnGuard(fileContent, input.line, message)) {
    return true;
  }

  if (!isLineCoherentWithMessage(lineText, message, suggestion)) {
    return true;
  }

  if (isObjectValuesEnumFalsePositive(lineText, message)) {
    return true;
  }

  if (isJsonStringifyLogFalsePositive(lineText, message)) {
    return true;
  }

  if (isCallbackShadowFalsePositive(lineText, message)) {
    return true;
  }

  if (isDefaultParameterFalsePositive(lineText, message)) {
    return true;
  }

  if (isDestructuringForOfFalsePositive(lineText, message)) {
    return true;
  }

  if (isI18nFallbackFalsePositive(lineText, message)) {
    return true;
  }

  if (isStrictBoolQueryFlagFalsePositive(lineText)) {
    return true;
  }

  if (isParseFloatWithFallbackFalsePositive(lineText, message)) {
    return true;
  }

  if (isKnexToQueryFalsePositive(lineText, message)) {
    return true;
  }

  if (isNonRuntimeLintIssue(lineText, message, suggestion)) {
    return true;
  }

  if (isDoubleSemicolonImportFalsePositive(lineText)) {
    return true;
  }

  if (isEmptyAsyncStubFalsePositive(lineText, message)) {
    return true;
  }

  if (isHasOwnPropertyFalsePositive(lineText, message)) {
    return true;
  }

  if (isRestDecoratorValidationFalsePositive(lineText, message, fileContent)) {
    return true;
  }

  return false;
};

export const normalizeIssueDedupeKey = (issue: { file: string; line: number; message: string; }): string => {
  const normalizedMessage = issue.message
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return `${issue.file}:${issue.line}:${normalizedMessage}`;
};

export const deduplicateIssues = <T extends { file: string; line: number; message: string; }>(issues: T[]): T[] => {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const issue of issues) {
    const key = normalizeIssueDedupeKey(issue);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(issue);
  }
  return result;
};
