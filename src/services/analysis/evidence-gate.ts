import type { IssueFilterInput } from '@/services/analysis/false-positive-filters';

const messageMatches = (message: string, patterns: RegExp[]): boolean =>
  patterns.some((pattern) => pattern.test(message));

/** Categories where runtime crash must be proven on the line, not inferred. */
const PROOF_REQUIRED_PATTERNS: RegExp[] = [
  /сигнатур/i,
  /вызов.*без/i,
  /обязательн.*параметр/i,
  /не\s+обрабатывается/i,
  /exhaustive/i,
  /enum/i,
  /race\s*condition/i,
  /гонк/i,
  /XSS/i,
  /уязвим/i,
  /\?\s*:\s*string/i,
  /опциональн.*пол/i,
  /message\?/i,
  /не\s+инициализир/i,
  /SQL/i,
  /запят/i,
  /синтаксис/i,
  /несуществующ/i,
  /COALESCE/i,
  /tenant_id/i,
  /parseInt/i,
  /NaN/i,
];

const hasUnprotectedPropertyAccess = (lineText: string): boolean => {
  const trimmed = lineText.trim();
  if (!trimmed || /^\s*\/\//.test(trimmed) || /^\s*\*/.test(trimmed)) {
    return false;
  }
  if (
    /\?\./.test(lineText)
    || /\?\?/.test(lineText)
    || /\|\|\s*[{'"]/.test(lineText)
    || /\bdelete\s+/.test(lineText)
    || /^\s*import\s+/.test(lineText)
    || /^\s*export\s+/.test(lineText)
    || /^\s*@\w+/.test(lineText)
    || /:\s*\w+(\[\])?\s*;?\s*$/.test(trimmed)
    || /\?\s*:\s*\w+/.test(lineText)
    || /^\s*}\s*;?\s*$/.test(trimmed)
  ) {
    return false;
  }
  return /\.\s*[a-zA-Z_$]|\[['"]/.test(lineText);
};

const requiresStrictProof = (message: string, suggestion?: string): boolean =>
  messageMatches(`${message} ${suggestion ?? ''}`, PROOF_REQUIRED_PATTERNS);

/**
 * Drops issues that claim runtime risk without an unprotected access pattern on the line.
 */
export const failsEvidenceGate = (input: IssueFilterInput): boolean => {
  const { lineText, message, suggestion } = input;
  const combined = `${message} ${suggestion ?? ''}`;

  if (!requiresStrictProof(message, suggestion)) {
    return false;
  }

  if (messageMatches(combined, [/race\s*condition/i, /гонк/i, /XSS/i, /уязвим/i])) {
    return true;
  }

  if (messageMatches(combined, [/сигнатур/i, /вызов.*без/i, /обязательн.*параметр/i])) {
    const isSignatureLine = /^\s*(?:export\s+)?(?:async\s+)?function\s+\w+/.test(lineText)
      || /^\s*(?:public|private|protected)\s+\w+\s*\(/.test(lineText);
    if (isSignatureLine) {
      return true;
    }
  }

  return !hasUnprotectedPropertyAccess(lineText);
};
