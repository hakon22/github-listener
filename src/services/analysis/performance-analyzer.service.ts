import type { CodeIssueInterface } from '@/services/analysis/code-analyzer.service';

interface PerformanceRule {
  pattern: RegExp;
  message: string;
  severity: CodeIssueInterface['severity'];
  suggestion?: string;
}

export class PerformanceAnalyzerService {
  private readonly patterns: PerformanceRule[] = [
    {
      pattern: /for\s*\(\s*let\s+i\s*=\s*0;.*length;.*\+\+\s*i\s*\)/,
      message: 'Potentially expensive loop over array length in hot path',
      severity: 'info',
      suggestion: 'Cache array length before the loop or consider more efficient iteration if this is a hot path.',
    },
    {
      pattern: /console\.log\(/,
      message: 'Console logging in production code can affect performance',
      severity: 'info',
      suggestion: 'Remove debug logging or guard it behind environment checks.',
    },
  ];

  public analyze = (content: string, filePath: string): CodeIssueInterface[] => {
    const issues: CodeIssueInterface[] = [];

    for (const rule of this.patterns) {
      const matches = content.match(rule.pattern);
      if (!matches) {
        continue;
      }

      const lines = content.split('\n');

      matches.forEach((match) => {
        const lineIndex = lines.findIndex((line) => line.includes(match));
        if (lineIndex !== -1) {
          issues.push({
            file: filePath,
            line: lineIndex + 1,
            severity: rule.severity,
            message: rule.message,
            rule: 'performance-pattern',
            suggestion: rule.suggestion,
          });
        }
      });
    }

    return issues;
  };
}
