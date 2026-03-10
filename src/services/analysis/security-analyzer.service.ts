import type { CodeIssueInterface } from '@/services/analysis/code-analyzer.service';

interface SecurityRule {
  pattern: RegExp;
  message: string;
  severity: CodeIssueInterface['severity'];
}

export class SecurityAnalyzerService {
  private readonly dangerousPatterns: SecurityRule[] = [
    {
      pattern: /eval\s*\(/,
      message: 'Avoid using eval() - security risk',
      severity: 'error',
    },
    {
      pattern: /child_process\.execSync/,
      message: 'Use child_process.execFile for better security',
      severity: 'warning',
    },
    {
      pattern: /process\.env\.([A-Z_]+)\s*[!=]==?\s*['"`]/,
      message: 'Hardcoded secrets in code',
      severity: 'error',
    },
    {
      pattern: /\.innerHTML\s*=/,
      message: 'Potential XSS vulnerability',
      severity: 'warning',
    },
  ];

  public analyze = (content: string, filePath: string): CodeIssueInterface[] => {
    const issues: CodeIssueInterface[] = [];

    for (const rule of this.dangerousPatterns) {
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
            rule: 'security-pattern',
          });
        }
      });
    }

    return issues;
  };
}
