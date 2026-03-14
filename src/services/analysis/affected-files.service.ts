import { Singleton } from 'typescript-ioc';
import * as path from 'path';
import ts from 'typescript';

const DEFAULT_TREE_FILE_LIMIT = 200;
const DEFAULT_AFFECTED_FILE_LIMIT = 50;

export interface GetAffectedPathsOptions {
  treeFileLimit?: number;
  affectedFileLimit?: number;
}

export interface AffectedFilesInput {
  getSourceFilePaths: () => Promise<string[]>;
  getFileContent: (filePath: string) => Promise<string>;
}

@Singleton
export class AffectedFilesService {
  public getAffectedPaths = async (
    changedPaths: string[],
    input: AffectedFilesInput,
    options?: GetAffectedPathsOptions,
  ): Promise<string[]> => {
    const treeFileLimit = options?.treeFileLimit ?? DEFAULT_TREE_FILE_LIMIT;
    const affectedFileLimit = options?.affectedFileLimit ?? DEFAULT_AFFECTED_FILE_LIMIT;

    const normalizedChangedSet = this.buildNormalizedPathSet(changedPaths);

    const allSourcePaths = await input.getSourceFilePaths();
    const pathsToScan = allSourcePaths.slice(0, treeFileLimit);

    const affectedPaths: string[] = [];
    const changedPathSet = new Set(changedPaths);

    for (const filePath of pathsToScan) {
      if (changedPathSet.has(filePath)) {
        continue;
      }
      if (affectedPaths.length >= affectedFileLimit) {
        break;
      }

      const content = await input.getFileContent(filePath);
      const importedPaths = this.extractRelativeImports(filePath, content);

      const isAffected = importedPaths.some((resolvedPath) => {
        const normalized = this.normalizePath(resolvedPath);
        return normalizedChangedSet.has(normalized);
      });

      if (isAffected) {
        affectedPaths.push(filePath);
      }
    }

    return affectedPaths;
  };

  private buildNormalizedPathSet = (paths: string[]): Set<string> => {
    const set = new Set<string>();
    for (const filePath of paths) {
      set.add(this.normalizePath(filePath));
    }
    return set;
  };

  private normalizePath = (filePath: string): string =>
    path.posix.normalize(filePath).replace(/\.(tsx?|jsx?)$/i, '');

  private extractRelativeImports = (filePath: string, content: string): string[] => {
    const sourceFile = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      true,
    );

    const dir = path.posix.dirname(filePath);
    const resolvedPaths: string[] = [];

    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node)) {
        const moduleSpecifier = node.moduleSpecifier;

        if (ts.isStringLiteral(moduleSpecifier)) {
          const specifier = moduleSpecifier.text;

          if (specifier.startsWith('.')) {
            const resolved = path.posix.normalize(path.posix.join(dir, specifier));
            resolvedPaths.push(resolved);
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);

    return resolvedPaths;
  };
}
