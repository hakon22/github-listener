import { Container, Singleton } from 'typescript-ioc';
import { SecurityAnalyzerService } from '@/services/analysis/security-analyzer.service';
import { PerformanceAnalyzerService } from '@/services/analysis/performance-analyzer.service';
import type { ScmChangeInterface } from '@/interfaces/scm-change.interface';

import { ESLint } from 'eslint';
import ts from 'typescript';
import * as path from 'path';

export interface CodeIssueInterface {
  file: string;
  line: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
  rule: string;
  suggestion?: string;
}

interface LogicalEntityChangeDetailsInterface {
  kind: 'entity-schema-change';
  entityName: string;
  file: string;
  addedProperties: Array<{
    name: string;
    type: string;
    decorators: string[];
  }>;
  removedProperties: Array<{
    name: string;
    type: string;
    decorators: string[];
  }>;
}

interface LogicalFunctionChangeDetailsInterface {
  kind: 'function-signature-change';
  functionName: string;
  className?: string;
  file: string;
  addedParameters: Array<{
    name: string;
    type: string;
    optional: boolean;
    hasDefault: boolean;
  }>;
  removedParameters: Array<{
    name: string;
    type: string;
    optional: boolean;
    hasDefault: boolean;
  }>;
}

type LogicalChangeDetailsInterface =
  | LogicalEntityChangeDetailsInterface
  | LogicalFunctionChangeDetailsInterface;

type EntityPropertyMetaInterface = {
  name: string;
  type: string;
  decorators: string[];
};

type EntitySchemaMetaInterface = {
  entityName: string;
  propertiesByName: Map<string, EntityPropertyMetaInterface>;
};

type FunctionParameterMetaInterface = {
  name: string;
  type: string;
  optional: boolean;
  hasDefault: boolean;
};

type FunctionSignatureMetaInterface = {
  kind: 'function' | 'method';
  name: string;
  className?: string;
  parameters: FunctionParameterMetaInterface[];
};

@Singleton
export class CodeAnalyzerService {
  private readonly eslint: ESLint;

  private readonly securityAnalyzer = Container.get(SecurityAnalyzerService);

  private readonly performanceAnalyzer = Container.get(PerformanceAnalyzerService);

  public constructor() {
    this.eslint = new ESLint({
      overrideConfig: {
        parser: '@typescript-eslint/parser',
        plugins: ['@typescript-eslint'],
        extends: [
          'eslint:recommended',
          'plugin:@typescript-eslint/recommended',
        ],
      },
      overrideConfigFile: null,
    } as any);
  }

  public analyzeChanges = async (changes: ScmChangeInterface[]): Promise<CodeIssueInterface[]> => {
    const issues: CodeIssueInterface[] = [];

    for (const change of changes) {
      const fileIssues = await this.analyzeFile(change.file, change.newContent);
      issues.push(...fileIssues);

      const logicalIssues = this.extractLogicalChangeCandidates(change);
      issues.push(...logicalIssues);
    }

    return issues;
  };

  public analyzeFile = async (filePath: string, content: string): Promise<CodeIssueInterface[]> => {
    const issues: CodeIssueInterface[] = [];

    const extension = path.extname(filePath).toLowerCase();

    const isAllowedFileExtension = [
      '.ts',
      '.tsx',
      '.js',
      '.jsx',
    ].includes(extension);

    // Security анализ
    const securityIssues = this.securityAnalyzer.analyze(content, filePath);
    issues.push(...securityIssues);

    // Performance анализ
    const perfIssues = this.performanceAnalyzer.analyze(content, filePath);
    issues.push(...perfIssues);

    if (!isAllowedFileExtension) {
      return issues;
    }

    // ESLint анализ
    const eslintResults = await this.eslint.lintText(content, { filePath });
    issues.push(...this.parseESLintResults(eslintResults));

    // TypeScript анализ
    const tsIssues = this.analyzeTypeScript(content, filePath);
    issues.push(...tsIssues);

    return issues;
  };

  private parseESLintResults = (results: ESLint.LintResult[]): CodeIssueInterface[] => {
    const workspaceRoot = process.cwd();

    return results.flatMap((result) =>
      result.messages.map((message) => ({
        file: path.relative(workspaceRoot, result.filePath),
        line: message.line,
        severity: this.mapSeverity(message.severity),
        message: message.message,
        rule: message.ruleId || 'unknown',
      })),
    );
  };

  private analyzeTypeScript = (content: string, filePath: string): CodeIssueInterface[] => {
    const issues: CodeIssueInterface[] = [];
    const sourceFile = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      true,
    );

    // Проверка на any тип
    const checkForAny = (node: ts.Node): void => {
      if (ts.isTypeReferenceNode(node) && node.typeName.getText() === 'any') {
        issues.push({
          file: filePath,
          line: sourceFile.getLineAndCharacterOfPosition(node.pos).line + 1,
          severity: 'warning',
          message: 'Avoid using "any" type',
          rule: 'no-explicit-any',
          suggestion: 'Use specific types or unknown',
        });
      }
      ts.forEachChild(node, checkForAny);
    };

    checkForAny(sourceFile);
    return issues;
  };

  private extractLogicalChangeCandidates = (change: ScmChangeInterface): CodeIssueInterface[] => {
    const issues: CodeIssueInterface[] = [];

    const extension = path.extname(change.file).toLowerCase();

    const isAllowedFileExtension = [
      '.ts',
      '.tsx',
    ].includes(extension);

    if (!isAllowedFileExtension) {
      return issues;
    }

    const oldContent = change.oldContent ?? '';
    const newContent = change.newContent ?? '';

    if (!oldContent.trim() || !newContent.trim()) {
      return issues;
    }

    const oldSourceFile = ts.createSourceFile(
      change.file,
      oldContent,
      ts.ScriptTarget.Latest,
      true,
    );

    const newSourceFile = ts.createSourceFile(
      change.file,
      newContent,
      ts.ScriptTarget.Latest,
      true,
    );

    const oldEntitySchemas = this.collectEntitySchemas(oldSourceFile);
    const newEntitySchemas = this.collectEntitySchemas(newSourceFile);

    for (const [entityName, newSchema] of newEntitySchemas.entries()) {
      const oldSchema = oldEntitySchemas.get(entityName);

      const addedProperties: EntityPropertyMetaInterface[] = [];
      const removedProperties: EntityPropertyMetaInterface[] = [];

      if (oldSchema) {
        for (const [propertyName, meta] of newSchema.propertiesByName.entries()) {
          if (!oldSchema.propertiesByName.has(propertyName)) {
            addedProperties.push(meta);
          }
        }

        for (const [propertyName, meta] of oldSchema.propertiesByName.entries()) {
          if (!newSchema.propertiesByName.has(propertyName)) {
            removedProperties.push(meta);
          }
        }
      }

      if (addedProperties.length || removedProperties.length) {
        const details: LogicalEntityChangeDetailsInterface = {
          kind: 'entity-schema-change',
          entityName,
          file: change.file,
          addedProperties,
          removedProperties,
        };

        issues.push({
          file: change.file,
          line: 1,
          severity: 'error',
          message: `Изменилась схема сущности "${entityName}". Проверьте, что создание и использование этой сущности обновлены.`,
          rule: 'logical-entity-schema-change',
          suggestion: JSON.stringify(details),
        });
      }
    }

    const oldFunctionSignatures = this.collectFunctionSignatures(oldSourceFile);
    const newFunctionSignatures = this.collectFunctionSignatures(newSourceFile);

    for (const [signatureName, newSignature] of newFunctionSignatures.entries()) {
      const oldSignature = oldFunctionSignatures.get(signatureName);

      if (!oldSignature) {
        continue;
      }

      const oldParametersByName = new Map<string, FunctionParameterMetaInterface>();
      oldSignature.parameters.forEach((parameter) => oldParametersByName.set(parameter.name, parameter));

      const newParametersByName = new Map<string, FunctionParameterMetaInterface>();
      newSignature.parameters.forEach((parameter) => newParametersByName.set(parameter.name, parameter));

      const addedParameters: FunctionParameterMetaInterface[] = [];
      const removedParameters: FunctionParameterMetaInterface[] = [];

      for (const [parameterName, meta] of newParametersByName.entries()) {
        if (!oldParametersByName.has(parameterName)) {
          addedParameters.push(meta);
        }
      }

      for (const [parameterName, meta] of oldParametersByName.entries()) {
        if (!newParametersByName.has(parameterName)) {
          removedParameters.push(meta);
        }
      }

      if (!addedParameters.length && !removedParameters.length) {
        continue;
      }

      const details: LogicalFunctionChangeDetailsInterface = {
        kind: 'function-signature-change',
        functionName: newSignature.name,
        className: newSignature.className,
        file: change.file,
        addedParameters,
        removedParameters,
      };

      issues.push({
        file: change.file,
        line: 1,
        severity: 'error',
        message: `Изменилась сигнатура функции или метода "${newSignature.name}". Проверьте все места, где она вызывается.`,
        rule: 'logical-function-signature-change',
        suggestion: JSON.stringify(details as LogicalChangeDetailsInterface),
      });
    }

    return issues;
  };

  private collectEntitySchemas = (sourceFile: ts.SourceFile): Map<string, EntitySchemaMetaInterface> => {
    const result = new Map<string, EntitySchemaMetaInterface>();

    const entityDecoratorNames = new Set<string>(['Entity']);
    const columnDecoratorNames = new Set<string>([
      'Column',
      'PrimaryColumn',
      'PrimaryGeneratedColumn',
      'ManyToOne',
      'OneToOne',
      'OneToMany',
      'ManyToMany',
    ]);

    const visitNode = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node) && node.name) {
        const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : [];

        const hasEntityDecorator = decorators.some((decorator) => {
          const expression = decorator.expression;

          if (ts.isCallExpression(expression)) {
            const identifier = expression.expression;

            if (ts.isIdentifier(identifier)) {
              return entityDecoratorNames.has(identifier.text);
            }
          }

          return false;
        });

        if (!hasEntityDecorator) {
          ts.forEachChild(node, visitNode);
          return;
        }

        const entityName = node.name.text;
        const propertiesByName = new Map<string, EntityPropertyMetaInterface>();

        for (const member of node.members) {
          if (!ts.isPropertyDeclaration(member) || !member.name) {
            continue;
          }

          const memberDecorators = ts.canHaveDecorators(member) ? ts.getDecorators(member) ?? [] : [];

          if (!memberDecorators.length) {
            continue;
          }

          const decoratorNames: string[] = [];
          let hasOrmDecorator = false;

          for (const decorator of memberDecorators) {
            const expression = decorator.expression;

            if (!ts.isCallExpression(expression)) {
              continue;
            }

            const identifier = expression.expression;

            if (!ts.isIdentifier(identifier)) {
              continue;
            }

            const decoratorName = identifier.text;
            decoratorNames.push(decoratorName);

            if (columnDecoratorNames.has(decoratorName)) {
              hasOrmDecorator = true;
            }
          }

          if (!hasOrmDecorator) {
            continue;
          }

          const propertyName = member.name.getText(sourceFile);
          const propertyType = member.type ? member.type.getText(sourceFile) : 'unknown';

          propertiesByName.set(propertyName, {
            name: propertyName,
            type: propertyType,
            decorators: decoratorNames,
          });
        }

        if (propertiesByName.size > 0) {
          result.set(entityName, {
            entityName,
            propertiesByName,
          });
        }
      }

      ts.forEachChild(node, visitNode);
    };

    ts.forEachChild(sourceFile, visitNode);

    return result;
  };

  private collectFunctionSignatures = (sourceFile: ts.SourceFile): Map<string, FunctionSignatureMetaInterface> => {
    const signatures = new Map<string, FunctionSignatureMetaInterface>();

    const buildParameters = (parameters: ts.NodeArray<ts.ParameterDeclaration>): FunctionParameterMetaInterface[] => {
      return parameters.map((parameter) => {
        const parameterName = parameter.name.getText(sourceFile);
        const parameterType = parameter.type ? parameter.type.getText(sourceFile) : 'any';
        const isOptional = Boolean(parameter.questionToken);
        const hasDefault = Boolean(parameter.initializer);

        return {
          name: parameterName,
          type: parameterType,
          optional: isOptional,
          hasDefault,
        };
      });
    };

    const visitNode = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name) {
        const parameters = buildParameters(node.parameters);
        const functionName = node.name.text;

        signatures.set(functionName, {
          kind: 'function',
          name: functionName,
          parameters,
        });
      }

      if (ts.isClassDeclaration(node) && node.name) {
        const className = node.name.text;

        for (const member of node.members) {
          if (ts.isMethodDeclaration(member) && member.name) {
            const parameters = buildParameters(member.parameters);
            const methodName = member.name.getText(sourceFile);
            const signatureName = `${className}.${methodName}`;

            signatures.set(signatureName, {
              kind: 'method',
              name: signatureName,
              className,
              parameters,
            });
          }
        }
      }

      ts.forEachChild(node, visitNode);
    };

    ts.forEachChild(sourceFile, visitNode);

    return signatures;
  };

  private mapSeverity = (severity: number): CodeIssueInterface['severity'] => {
    switch (severity) {
    case 2:
      return 'error';
    case 1:
      return 'warning';
    default:
      return 'info';
    }
  };
}
