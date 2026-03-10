import { Container, Singleton } from 'typescript-ioc';
import type { ExtraReplyMessage } from 'telegraf/typings/telegram-types';

import { LoggerService } from '@/services/core/logger.service';
import { TelegramBotService } from '@/services/notifications/telegram-bot.service';

@Singleton
export class TelegramService {
  private readonly TAG = 'TelegramService';

  private readonly loggerService = Container.get(LoggerService);

  private readonly telegramBotService = Container.get(TelegramBotService);

  public sendAdminMessage = async (message: string | string[], options?: ExtraReplyMessage) => {
    const telegramId = process.env.TELEGRAM_CHAT_ID;

    if (!telegramId) {
      this.loggerService.warn(this.TAG, 'TELEGRAM_CHAT_ID is not set, admin message is skipped');
      return;
    }

    await this.sendMessage(message, telegramId, options);
  };

  public sendMessage = async (message: string | string[], telegramId: string, options?: ExtraReplyMessage) => {
    const text = this.serializeText(message);

    const result = await this.telegramBotService.sendMessage(text, telegramId, options);
    if (result?.message_id) {
      this.loggerService.info(this.TAG, `Сообщение в Telegram на telegramId ${telegramId} успешно отправлено`);
      return { ...result, text };
    }
  };

  private serializeText = (message: string | string[]) => Array.isArray(message) ? message.reduce((acc, field) => acc += `${field}\n`, '') : message;
}
