import { Singleton } from 'typescript-ioc';
import { ChatMistralAI, MistralAIEmbeddings } from '@langchain/mistralai';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

import { BaseService } from '@/services/core/base.service';

@Singleton
export abstract class ModelBaseService extends BaseService {
  protected getChatModel = (): BaseChatModel => {
    const apiKey = process.env.MISTRAL_API_KEY ?? '';

    return new ChatMistralAI({
      apiKey,
    });
  };

  protected getEmbeddingModel = (): MistralAIEmbeddings => {
    const apiKey = process.env.MISTRAL_API_KEY ?? '';

    return new MistralAIEmbeddings({
      apiKey,
    });
  };
}
