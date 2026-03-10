import { Singleton } from 'typescript-ioc';

import type { ScmChangeInterface } from '@/interfaces/scm-change.interface';

@Singleton
export class ScmChangeBuilderService {
  public buildSnapshotChanges = async (
    paths: string[],
    getFileContent: (filePath: string) => Promise<string>,
  ): Promise<ScmChangeInterface[]> => Promise.all(
    paths.map(async (filePath) => ({
      file: filePath,
      oldContent: '',
      newContent: await getFileContent(filePath),
      diff: '',
    })),
  );

  public buildPushChanges = async (
    paths: string[],
    getOldFileContent: (filePath: string) => Promise<string>,
    getNewFileContent: (filePath: string) => Promise<string>,
    diffByPath: Map<string, string>,
  ): Promise<ScmChangeInterface[]> => Promise.all(
    paths.map(async (filePath) => {
      const [oldContent, newContent] = await Promise.all([
        getOldFileContent(filePath),
        getNewFileContent(filePath),
      ]);

      return {
        file: filePath,
        oldContent,
        newContent,
        diff: diffByPath.get(filePath) ?? '',
      };
    }),
  );
}
