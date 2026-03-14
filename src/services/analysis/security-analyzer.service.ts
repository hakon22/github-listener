import { Singleton } from 'typescript-ioc';
import type { CodeIssueInterface } from '@/services/analysis/code-analyzer.service';

interface SecurityRule {
  pattern: RegExp;
  message: string;
  severity: CodeIssueInterface['severity'];
}

@Singleton
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
      pattern: /\.innerHTML\s*=/,
      message: 'Potential XSS vulnerability',
      severity: 'warning',
    },
  ];

  public analyze = (content: string, filePath: string): CodeIssueInterface[] => {
    const issues: CodeIssueInterface[] = [];
    const lines = content.split('\n');

    for (const rule of this.dangerousPatterns) {
      const pattern = rule.pattern.global ? rule.pattern : new RegExp(rule.pattern.source, 'g');
      const matchIterator = content.matchAll(pattern);

      for (const match of matchIterator) {
        const fullMatch = match[0];
        const lineIndex = lines.findIndex((line) => line.includes(fullMatch));
        if (lineIndex !== -1) {
          issues.push({
            file: filePath,
            line: lineIndex + 1,
            severity: rule.severity,
            message: rule.message,
            rule: 'security-pattern',
          });
        }
      }
    }

    return issues;
  };
}
