/**
 * Utilities for matching code issues against unified diff hunks.
 */

export interface ParsedDiffLines {
  /** 1-based line numbers in the new file that appear in + or context (space) hunks */
  newFileTouchedLines: Set<number>;
  /** Text of lines removed in the diff (without leading '-') */
  removedLineTexts: string[];
  /** Text of lines added in the diff (without leading '+') */
  addedLineTexts: string[];
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/** Parses unified diff and tracks which new-file line numbers belong to the change hunks. */
export const parseDiffLines = (diff: string): ParsedDiffLines => {
  const newFileTouchedLines = new Set<number>();
  const removedLineTexts: string[] = [];
  const addedLineTexts: string[] = [];

  if (!diff?.trim()) {
    return { newFileTouchedLines, removedLineTexts, addedLineTexts };
  }

  let newLine = 0;

  for (const rawLine of diff.split('\n')) {
    const hunkMatch = rawLine.match(HUNK_HEADER);
    if (hunkMatch) {
      newLine = Number.parseInt(hunkMatch[1], 10) - 1;
      continue;
    }

    if (rawLine.startsWith('---') || rawLine.startsWith('+++')) {
      continue;
    }

    if (rawLine.startsWith('-')) {
      removedLineTexts.push(rawLine.slice(1));
      continue;
    }

    if (rawLine.startsWith('+')) {
      newLine += 1;
      newFileTouchedLines.add(newLine);
      addedLineTexts.push(rawLine.slice(1));
      continue;
    }

    if (rawLine.startsWith(' ')) {
      newLine += 1;
      newFileTouchedLines.add(newLine);
    }
  }

  return { newFileTouchedLines, removedLineTexts, addedLineTexts };
};

const normalizeForCompare = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** True if the issue line is outside all diff hunks in the new file (pre-existing context only). */
export const isLineOutsideDiffHunks = (diff: string, lineOneBased: number): boolean => {
  const parsed = parseDiffLines(diff);
  if (parsed.newFileTouchedLines.size === 0) {
    return false;
  }
  return !parsed.newFileTouchedLines.has(lineOneBased);
};

/**
 * True if the message clearly refers to code that exists only in removed (-) diff lines,
 * not on the reported line in the new file.
 */
export const isMessageAboutRemovedDiffOnly = (
  diff: string,
  lineText: string,
  message: string,
): boolean => {
  const parsed = parseDiffLines(diff);
  if (!parsed.removedLineTexts.length) {
    return false;
  }

  const normalizedLine = normalizeForCompare(lineText);
  const quotedInMessage = message.match(/['"`]([^'"`]+)['"`]/g)?.map((q) => q.slice(1, -1)) ?? [];

  for (const fragment of quotedInMessage) {
    const trimmed = fragment.trim();
    if (trimmed.length < 4) {
      continue;
    }
    const inRemoved = parsed.removedLineTexts.some((removed) => removed.includes(trimmed));
    const inCurrentLine = normalizedLine.includes(trimmed);
    if (inRemoved && !inCurrentLine) {
      return true;
    }
  }

  return false;
};

/** True if recommendation is already present on the line (fix applied in this commit). */
export const isRecommendationAlreadyApplied = (lineText: string, message: string, suggestion?: string): boolean => {
  const combined = `${message} ${suggestion ?? ''}`.toLowerCase();

  if (
    (combined.includes('json.stringify') || combined.includes('сериализ'))
    && /JSON\.stringify\s*\(/.test(lineText)
  ) {
    return true;
  }

  if (
    (combined.includes('optional chaining') || combined.includes('?.'))
    && /\?\./.test(lineText)
  ) {
    return true;
  }

  if (combined.includes('??') && /\?\?/.test(lineText)) {
    return true;
  }

  if (
    (combined.includes('import') && combined.includes('require'))
    && /^\s*import\s+/.test(lineText)
  ) {
    return true;
  }

  if (
    (combined.includes('await') || combined.includes('асинхрон'))
    && /\bawait\b/.test(lineText)
  ) {
    return true;
  }

  if (
    (combined.includes('try') || combined.includes('catch') || combined.includes('исключен'))
    && /\btry\s*\{/.test(lineText)
  ) {
    return true;
  }

  if (
    (combined.includes('fallback') || combined.includes('||'))
    && /\|\|\s*[{'"]/.test(lineText)
  ) {
    return true;
  }

  if (
    (combined.includes('слэш') || combined.includes('slash') || combined.includes('url') || combined.includes('URL'))
    && /\$\{[^}]+\}\$\{/.test(lineText)
  ) {
    return true;
  }

  return false;
};

/** Suggestion asks to add slash but current line already concatenates without extra slash. */
export const isIntentionalUrlSlashChangeInDiff = (
  lineText: string,
  message: string,
  suggestion: string | undefined,
  diff: string | undefined,
): boolean => {
  if (!diff) {
    return false;
  }
  const combined = `${message} ${suggestion ?? ''}`.toLowerCase();
  if (!combined.includes('слэш') && !combined.includes('slash') && !combined.includes('url')) {
    return false;
  }
  const wantsSlash = /добавьте\s+слэш|add\s+slash|\/\s*в\s+начало/i.test(combined);
  const wantsNoSlash = /уберите\s+слэш|лишн.*слэш|without\s+slash/i.test(combined);
  const lineHasJoin = /\$\{[^}]+\}\$\{/.test(lineText) && !/\$\{[^}]+\}\/\$\{/.test(lineText);
  const lineHasSlashJoin = /\$\{[^}]+\}\/\$\{/.test(lineText);

  const parsed = parseDiffLines(diff);
  const removedHadSlash = parsed.removedLineTexts.some((t) => /\$\{[^}]+\}\/\$\{/.test(t));
  const addedWithoutSlash = parsed.addedLineTexts.some((t) => /\$\{[^}]+\}\$\{/.test(t) && !/\$\{[^}]+\}\/\$\{/.test(t));

  if (wantsSlash && lineHasJoin && (removedHadSlash || addedWithoutSlash)) {
    return true;
  }
  if (wantsNoSlash && lineHasSlashJoin) {
    return true;
  }
  return false;
};
