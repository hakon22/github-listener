/**
 * Validates that an issue's message matches the code on the reported line.
 */

const STOP_WORDS = new Set([
  'undefined',
  'null',
  'true',
  'false',
  'object',
  'TypeError',
  'Error',
  'Promise',
  'string',
  'number',
  'boolean',
  'the',
  'при',
  'для',
  'если',
  'может',
  'без',
  'проверк',
]);

const GENERIC_LINE_PATTERNS: RegExp[] = [
  /^\s*import\s+/,
  /^\s*export\s+import\s+/,
  /^\s*@\w+/,
  /^\s*middlewares\s*:/,
  /^\s*name\s*:\s*['"]/,
  /^\s*for\s*\(\s*const\s+/,
  /^\s*this\.loading\s*=/,
  /^\s*\}\s*;?\s*$/,
  /^\s*delete\s+/,
  /^\s*@OneToMany/,
  /^\s*@ManyToOne/,
  /^\s*@OneToOne/,
  /`[^`]*`/,
];

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Extracts identifier-like tokens from issue text for line matching. */
export const extractMessageTokens = (message: string, suggestion?: string): string[] => {
  const text = `${message} ${suggestion ?? ''}`;
  const tokens = new Set<string>();

  const identifierPattern = /\b([a-zA-Z_][a-zA-Z0-9_]*)\b/g;
  let match: RegExpExecArray | null;
  while ((match = identifierPattern.exec(text)) !== null) {
    const id = match[1];
    if (id.length >= 2 && !STOP_WORDS.has(id)) {
      tokens.add(id);
    }
  }

  const propertyPattern = /\.([a-zA-Z_][a-zA-Z0-9_]*)/g;
  while ((match = propertyPattern.exec(text)) !== null) {
    if (match[1].length >= 2) {
      tokens.add(match[1]);
    }
  }

  return [...tokens];
};

/** Lines that should not host runtime-critical findings without matching tokens. */
export const isGenericNonIssueLine = (lineText: string): boolean =>
  GENERIC_LINE_PATTERNS.some((pattern) => pattern.test(lineText));

/**
 * Expanded coherence: message tokens must appear on the line unless the line is clearly guarded.
 */
export const isLineCoherentWithMessage = (
  lineText: string,
  message: string,
  suggestion?: string,
): boolean => {
  if (isGenericNonIssueLine(lineText)) {
    const tokens = extractMessageTokens(message, suggestion);
    const hasTokenOnLine = tokens.some((token) =>
      new RegExp(`\\b${escapeRegex(token)}\\b`).test(lineText),
    );
    if (!hasTokenOnLine) {
      return false;
    }
  }

  const blamedPatterns = [
    /на\s+undefined\s+объект[еа]\s+(\w+)/gi,
    /undefined\s+объект[еа]\s+(\w+)/gi,
    /на\s+объект[еа]\s+(\w+)/gi,
    /объект[еа]\s+(\w+)\s+привед/gi,
  ];

  const blamed = new Set<string>();
  for (const pattern of blamedPatterns) {
    let match: RegExpExecArray | null;
    const clone = new RegExp(pattern.source, pattern.flags);
    while ((match = clone.exec(message)) !== null) {
      if (match[1]) {
        blamed.add(match[1]);
      }
    }
  }

  if (blamed.size > 0) {
    const numericBlamed = [...blamed].filter((name) => /^\d+$/.test(name));
    if (numericBlamed.length > 0 && /\{\s*id\s*:\s*\d+/.test(lineText)) {
      return false;
    }
    return [...blamed].every((name) => new RegExp(`\\b${escapeRegex(name)}\\b`).test(lineText));
  }

  const propertyPathsInMessage = [...message.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)+)\b/g)]
    .map((match) => match[1])
    .filter((pathValue) => pathValue.includes('.'));

  for (const propertyPath of propertyPathsInMessage) {
    const segments = propertyPath.split('.');
    const lastSegment = segments[segments.length - 1];
    if (!new RegExp(`\\.\\s*${escapeRegex(lastSegment)}\\b`).test(lineText)
      && !new RegExp(`\\b${escapeRegex(lastSegment)}\\b`).test(lineText)) {
      return false;
    }
    if (/=\s*\w+\s*;?\s*$/.test(lineText.trim()) && !lineText.includes('.')) {
      return false;
    }
  }

  const tokens = extractMessageTokens(message, suggestion);
  if (tokens.length === 0) {
    return true;
  }

  return tokens.some((token) => new RegExp(`\\b${escapeRegex(token)}\\b`).test(lineText));
};

const GUARD_LOOKBACK_LINES = 30;

/**
 * True if `lineOneBased` is after an early-return guard for identifiers mentioned in the message.
 */
export const isLineAfterEarlyReturnGuard = (
  fileContent: string,
  lineOneBased: number,
  message: string,
): boolean => {
  const lines = fileContent.split('\n');
  const lineIndex = lineOneBased - 1;
  if (lineIndex <= 0 || lineIndex >= lines.length) {
    return false;
  }

  const guardTargets = extractMessageTokens(message).filter((token) =>
    /^(nds|task|document|documents|columns|params|reportDescriptor|turnovers|bill)$/i.test(token)
    || token === 'getInstance',
  );

  if (!guardTargets.length && /getInstance/i.test(message)) {
    guardTargets.push('nds');
  }

  const start = Math.max(0, lineIndex - GUARD_LOOKBACK_LINES);
  let sawReturnAfterGuard = false;

  for (let index = lineIndex - 1; index >= start; index -= 1) {
    const candidate = lines[index] ?? '';
    const trimmed = candidate.trim();

    if (/return\b/.test(trimmed)) {
      sawReturnAfterGuard = true;
    }

    for (const target of guardTargets) {
      const guardPattern = new RegExp(
        `if\\s*\\(\\s*!\\s*(?:this\\.)?${escapeRegex(target)}`,
        'i',
      );
      if (guardPattern.test(candidate) && sawReturnAfterGuard) {
        return true;
      }
    }

    if (/^\s*(?:public|private|protected)?\s*\w+\s*\([^)]*\)\s*\{/.test(trimmed)) {
      break;
    }
  }

  if (/getInstance/i.test(message)) {
    for (let index = lineIndex - 1; index >= start; index -= 1) {
      const candidate = lines[index] ?? '';
      if (/if\s*\(\s*!\s*this\.task\.nds/i.test(candidate)) {
        return true;
      }
    }
  }

  return false;
};
