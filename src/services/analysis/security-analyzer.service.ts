import { Singleton } from 'typescript-ioc';
import type { CodeIssueInterface } from '@/services/analysis/code-analyzer.service';

interface SecurityRule {
  pattern: RegExp;
  message: string;
  severity: CodeIssueInterface['severity'];
  /** Для правила «захардкоженные секреты» — сравниваемое значение не считается секретом, если оно в этом списке */
  skipWhenValueEquals?: string[];
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
      pattern: /process\.env\.([A-Z_]+)\s*[!=]==?\s*['"]([^'"]*)['"]/g,
      message: 'Hardcoded secrets in code',
      severity: 'error',
      skipWhenValueEquals: ['true', 'false', ''],
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
        const comparedValue = match[2];

        if (rule.skipWhenValueEquals && typeof comparedValue === 'string' && rule.skipWhenValueEquals.includes(comparedValue)) {
          continue;
        }

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
