import { HttpsProxyAgent } from 'https-proxy-agent';
import { Telegraf } from 'telegraf';
import { Container, Singleton } from 'typescript-ioc';
import type { ExtraReplyMessage } from 'telegraf/typings/telegram-types';
import type { Context } from 'telegraf';

import { LoggerService } from '@/services/core/logger.service';

@Singleton
export class TelegramBotService {
  private readonly TAG = 'TelegramBotService';

  private readonly loggerService = Container.get(LoggerService);

  private bot: Telegraf<Context> | null = null;

  private readonly proxyAgent: HttpsProxyAgent<any> | null = process.env.PROXY_USER && process.env.PROXY_PASS && process.env.PROXY_HOST
    ? new HttpsProxyAgent(`http://${process.env.PROXY_USER}:${process.env.PROXY_PASS}@${process.env.PROXY_HOST}`)
    : null;

  public getProxyAgent = (): HttpsProxyAgent<any> | null => this.proxyAgent;

  public init = async () => {
    try {
      this.bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN ?? '', this.proxyAgent
        ? {
          telegram: {
            agent: this.proxyAgent,
          },
        }
        : {});

      this.loggerService.info(this.TAG, 'Telegram bot initialized');
    } catch (e) {
      this.loggerService.error(this.TAG, e);
    }
  };

  public getBot = () => {
    if (!this.bot) {
      throw new Error('Telegram bot is not initialized. Call init() first.');
    }

    return this.bot;
  };

  public sendMessage = async (text: string, telegramId: string, options?: ExtraReplyMessage) => {
    try {
      return this.getBot().telegram.sendMessage(telegramId, text, {
        parse_mode: 'HTML',
        ...options,
      });
    } catch (e) {
      this.loggerService.error(this.TAG, `Ошибка отправки сообщения на telegramId ${telegramId} :(`, e);
      throw e;
    }
  };
}
