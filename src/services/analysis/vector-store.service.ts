import { ModelBaseService } from '@/services/core/model-base.service';
import type { ScmChangeInterface } from '@/interfaces/scm-change.interface';

import { Singleton } from 'typescript-ioc';
import type { OpenAIEmbeddings } from '@langchain/openai';

interface CodeVectorEntry {
  file: string;
  content: string;
  embedding: number[];
}

@Singleton
export class VectorStoreService extends ModelBaseService {
  protected override readonly TAG: string = 'VectorStoreService';

  private embeddings: OpenAIEmbeddings | null = null;

  private vectors: CodeVectorEntry[] = [];

  /** timestamp последнего запроса к OpenAI (ms) */
  private lastEmbeddingCallAt = 0;

  private readonly EMBEDDING_RATE_LIMIT_MS = 1000;

  /**
   * Глобальный (по процессу) rate-limit для вызовов OpenAI embeddings:
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

  private getEmbeddings = async (): Promise<OpenAIEmbeddings> => {
    if (this.embeddings) {
      return this.embeddings;
    }

    this.embeddings = this.getEmbeddingModel();

    return this.embeddings;
  };

  /**
   * Индексация кода в MR: каждая новая версия файла превращается в вектор.
   * Требуется ответ API в формате OpenAI: { data: [ { embedding: number[] } ] }.
   * При несовместимом OPENAI_BASE_URL задайте VECTOR_EMBEDDINGS_ENABLED=false.
   */
  public indexMergeRequestChanges = async (changes: ScmChangeInterface[]): Promise<void> => {
    if (process.env.VECTOR_EMBEDDINGS_ENABLED === 'false') {
      this.vectors = [];
      this.loggerService.debug(this.TAG, 'Vector embeddings disabled by VECTOR_EMBEDDINGS_ENABLED');
      return;
    }

    if (!changes.length) {
      this.vectors = [];
      this.loggerService.debug(this.TAG, 'indexMergeRequestChanges: no changes, clearing vectors');
      return;
    }

    this.loggerService.info(this.TAG, `Indexing ${changes.length} file changes for embeddings`);

    // Разбиваем большие файлы на чанки, чтобы не превышать лимит токенов модели.
    // Ожидается, что вызывающий код передаёт уже отфильтрованный список (без .md) — фильтрация в ScmReviewService.
    const items: { file: string; content: string; }[] = [];

    for (const change of changes) {
      const normalized = this.normalizeContent(change.newContent ?? '');
      const chunks = this.chunkContent(normalized);

      for (const chunk of chunks) {
        if (chunk.length > 0) {
          items.push({
            file: change.file,
            content: chunk,
          });
        }
      }
    }

    if (!items.length) {
      this.vectors = [];
      return;
    }

    try {
      const embeddingsModel = await this.getEmbeddings();

      // OpenAI ограничивает общее число токенов в одном запросе и частоту запросов,
      // поэтому эмбеддим документы батчами и с rate-limit (не более 1 запроса в секунду).
      const BATCH_SIZE = 8;
      const vectors: CodeVectorEntry[] = [];

      for (let i = 0; i < items.length; i += BATCH_SIZE) {
        const batchItems = items.slice(i, i + BATCH_SIZE);
        const texts = batchItems.map((item) => item.content);

        const batchEmbeddings = await this.withEmbeddingRateLimit(() =>
          embeddingsModel.embedDocuments(texts),
        );

        if (!Array.isArray(batchEmbeddings) || batchEmbeddings.length !== batchItems.length) {
          this.loggerService.warn(
            this.TAG,
            `Embedding API returned unexpected format: expected array of length ${batchItems.length}, got ${Array.isArray(batchEmbeddings) ? batchEmbeddings.length : 'non-array'}. Skipping batch.`,
          );
          continue;
        }

        batchEmbeddings.forEach((embedding: number[], index: number) => {
          if (!Array.isArray(embedding) || embedding.length === 0) {
            return;
          }
          const item = batchItems[index];
          vectors.push({
            file: item.file,
            content: item.content,
            embedding,
          });
        });
      }

      this.vectors = vectors;
      this.loggerService.info(this.TAG, `Embeddings built successfully: ${vectors.length} vectors`);
    } catch (error) {
      const errorInstance = error as Error;
      const isFormatError = /reading '0'|\.data\[0\]|data\.embedding/i.test(errorInstance.message ?? '');
      this.loggerService.error(
        this.TAG,
        'Failed to build embeddings for changes',
        errorInstance,
      );
      if (isFormatError) {
        this.loggerService.warn(
          this.TAG,
          'Embedding API must return OpenAI-compatible format: { data: [ { embedding: number[] } ] }. '
          + 'If using a custom OPENAI_BASE_URL that does not support this, set VECTOR_EMBEDDINGS_ENABLED=false to disable vector search.',
        );
      }
      this.vectors = [];
    }
  };

  /**
   * Находит наиболее похожие по смыслу файлы относительно запроса.
   * Возвращает путь, контент и similarity score.
   */
  public findSimilarCode = async (query: string, limit = 5): Promise<(CodeVectorEntry & { score: number; })[]> => {
    if (process.env.VECTOR_EMBEDDINGS_ENABLED === 'false' || !query.trim() || !this.vectors.length) {
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
      this.loggerService.error(this.TAG, 'Failed to compute embedding for OpenAI query', errorInstance);

      // Если OpenAI недоступен, просто не используем поиск похожего кода.
      return [];
    }
  };

  private normalizeContent = (content: string): string => {
    return content.replace(/\s+/g, ' ').trim();
  };

  /**
   * Разбиение по символам под лимит эмбеддинг-модели 8K токенов.
   * 8K токенов × ~4 символа/токен ≈ 32K символов на чанк.
   */
  private static readonly EMBEDDING_MAX_CHARS_PER_CHUNK = 32000;

  private chunkContent = (content: string, maxChars = VectorStoreService.EMBEDDING_MAX_CHARS_PER_CHUNK): string[] => {
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
