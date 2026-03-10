import { ModelBaseService } from '@/services/core/model-base.service';
import type { ScmChangeInterface } from '@/interfaces/scm-change.interface';

import { Singleton } from 'typescript-ioc';
import type { MistralAIEmbeddings } from '@langchain/mistralai';

interface CodeVectorEntry {
  file: string;
  content: string;
  embedding: number[];
}

@Singleton
export class VectorStoreService extends ModelBaseService {
  private embeddings: MistralAIEmbeddings | null = null;

  private vectors: CodeVectorEntry[] = [];

  /** timestamp последнего запроса к Mistral (ms) */
  private lastEmbeddingCallAt = 0;

  private readonly EMBEDDING_RATE_LIMIT_MS = 1000;

  /**
   * Глобальный (по процессу) rate-limit для вызовов Mistral embeddings:
   * не более одного HTTP-запроса в секунду.
   */
  private withEmbeddingRateLimit = async <T>(fn: () => Promise<T>): Promise<T> => {
    const now = Date.now();
    const elapsed = now - this.lastEmbeddingCallAt;

    if (elapsed < this.EMBEDDING_RATE_LIMIT_MS) {
      const delay = this.EMBEDDING_RATE_LIMIT_MS - elapsed;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    const start = Date.now();
    const result = await fn();
    this.lastEmbeddingCallAt = start;

    return result;
  };

  private getEmbeddings = async (): Promise<MistralAIEmbeddings> => {
    if (this.embeddings) {
      return this.embeddings;
    }

    this.embeddings = this.getEmbeddingModel();

    return this.embeddings;
  };

  /**
   * Индексация кода в MR: каждая новая версия файла превращается в вектор.
   */
  public indexMergeRequestChanges = async (changes: ScmChangeInterface[]): Promise<void> => {
    if (!changes.length) {
      this.vectors = [];
      return;
    }

    // Разбиваем большие файлы на чанки, чтобы не превышать лимит токенов модели.
    const items: { file: string; content: string; }[] = [];

    for (const change of changes) {
      const normalized = this.normalizeContent(change.newContent);
      const chunks = this.chunkContent(normalized);

      for (const chunk of chunks) {
        items.push({
          file: change.file,
          content: chunk,
        });
      }
    }

    if (!items.length) {
      this.vectors = [];
      return;
    }

    try {
      const embeddingsModel = await this.getEmbeddings();

      // Mistral ограничивает общее число токенов в одном запросе и частоту запросов,
      // поэтому эмбеддим документы батчами и с rate-limit (не более 1 запроса в секунду).
      const BATCH_SIZE = 8;
      const vectors: CodeVectorEntry[] = [];

      for (let i = 0; i < items.length; i += BATCH_SIZE) {
        const batchItems = items.slice(i, i + BATCH_SIZE);
        const batchEmbeddings = await this.withEmbeddingRateLimit(() =>
          embeddingsModel.embedDocuments(batchItems.map(({ content }) => content)),
        );

        batchEmbeddings.forEach((embedding: number[], index: number) => {
          const item = batchItems[index];
          vectors.push({
            file: item.file,
            content: item.content,
            embedding,
          });
        });
      }

      this.vectors = vectors;
    } catch (error) {
      const errorInstance = error as Error;
      this.loggerService.error('Failed to build embeddings for GitLab changes', {
        error: {
          name: errorInstance?.name || String(error),
          message: errorInstance?.message || String(error),
          stack: errorInstance?.stack,
        },
      });

      // В случае ошибок Mistral просто отключаем векторный поиск для этого пуша,
      // чтобы не ломать весь пайплайн анализа.
      this.vectors = [];
    }
  };

  /**
   * Находит наиболее похожие по смыслу файлы относительно запроса.
   * Возвращает путь, контент и similarity score.
   */
  public findSimilarCode = async (query: string, limit = 5): Promise<Array<CodeVectorEntry & { score: number; }>> => {
    if (!query.trim() || !this.vectors.length) {
      return [];
    }

    try {
      const embeddingsModel = await this.getEmbeddings();
      const queryEmbedding = await this.withEmbeddingRateLimit(() =>
        embeddingsModel.embedQuery(this.normalizeContent(query)),
      ) as number[];

      const withScores = this.vectors.map((entry) => ({
        ...entry,
        score: this.cosineSimilarity(queryEmbedding, entry.embedding),
      }));

      return withScores
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    } catch (error) {
      const errorInstance = error as Error;
      this.loggerService.error('Failed to compute embedding for GitLab query', {
        error: {
          name: errorInstance?.name || String(error),
          message: errorInstance?.message || String(error),
          stack: errorInstance?.stack,
        },
      });

      // Если Mistral недоступен, просто не используем поиск похожего кода.
      return [];
    }
  };

  private normalizeContent = (content: string): string => {
    return content.replace(/\s+/g, ' ').trim();
  };

  /**
   * Грубое разбиение по символам, чтобы не упираться в лимит 8192 токена.
   * Для кода берём ~8000 символов на чанк, что даёт заметный запас по токенам.
   */
  private chunkContent = (content: string, maxChars = 8000): string[] => {
    if (content.length <= maxChars) {
      return [content];
    }

    const chunks: string[] = [];

    for (let i = 0; i < content.length; i += maxChars) {
      chunks.push(content.slice(i, i + maxChars));
    }

    return chunks;
  };

  private cosineSimilarity = (a: number[], b: number[]): number => {
    const len = Math.min(a.length, b.length);
    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < len; i += 1) {
      const valueA = a[i];
      const valueB = b[i];
      dot += valueA * valueB;
      normA += valueA * valueA;
      normB += valueB * valueB;
    }

    if (!normA || !normB) {
      return 0;
    }

    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  };
}
