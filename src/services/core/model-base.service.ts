import { Singleton } from 'typescript-ioc';
import { ChatOpenAI, OpenAIEmbeddings } from '@langchain/openai';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

import { BaseService } from '@/services/core/base.service';

@Singleton
export abstract class ModelBaseService extends BaseService {
  protected getChatModel = (): BaseChatModel => {
    const apiKey = process.env.OPENAI_API_KEY ?? '';
    const baseURL = process.env.OPENAI_BASE_URL ?? '';
    const model = process.env.OPENAI_MODEL ?? '';

    return new ChatOpenAI({
      apiKey,
      configuration: {
        baseURL,
      },
      model,
    });
  };

  protected getEmbeddingModel = (): OpenAIEmbeddings => {
    const apiKey = process.env.OPENAI_API_KEY ?? '';
    const baseURL = process.env.OPENAI_BASE_URL ?? '';
    const model = process.env.OPENAI_EMBEDDING_MODEL ?? '';

    return new OpenAIEmbeddings({
      apiKey,
      configuration: {
        baseURL,
      },
      model,
      dimensions: 1536,
    });
  };
}
