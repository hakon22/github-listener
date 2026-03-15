import { Container } from 'typescript-ioc';
import type { Response } from 'express';

import { LoggerService } from '@/services/core/logger.service';
import { TelegramService } from '@/services/notifications/telegram.service';

export abstract class BaseService {
  protected readonly TAG: string = 'BaseService';

  protected loggerService = Container.get(LoggerService);

  protected telegramService = Container.get(TelegramService);

  protected defer = (task: () => Promise<void> | void): void => {
    setImmediate(async () => {
      try {
        await task();
      } catch (error) {
        const errorInstance = error as Error;

        this.loggerService.error(this.TAG, 'Unhandled error in deferred task', errorInstance);
      }
    });
  };

  protected logWebhookProcessed = (providerName: 'GitHub' | 'GitLab', eventName: string, extras: Record<string, unknown>): void => {
    this.loggerService.info(this.TAG, `${providerName} ${eventName} event processed and notification sent`, {
      extras,
    });
  };

  protected handleWebhookProcessingError = (providerName: 'GitHub' | 'GitLab', error: unknown, response: Response): Response => {
    const errorInstance = error as Error;

    this.loggerService.error(this.TAG, `Error ocurred during ${providerName} webhook processing`, errorInstance);

    this.errorHandler(error, response);
    return response;
  };

  protected errorHandler = (e: any, res: Response, statusCode = 500) => {
    this.loggerService.error(this.TAG, e);

    let error = `${e?.name}: ${e?.message}`;

    if (e?.name === 'ValidationError') {
      error = `${e?.name}: "${e?.path}" ${e?.message}`;
    }

    if (e instanceof Error && e.stack && process.env.TELEGRAM_CHAT_ID && process.env.NODE_ENV === 'production') {
      const fileLabel = this.getFileLabelFromStack(e.stack);
      const message = [
        `Ошибка на сервере <b>${process.env.APP_NAME}</b>:`,
        `<pre><code class="language-${fileLabel}">${e.stack}</code></pre>`,
      ];

      this.defer(() => this.telegramService.sendAdminMessage(message, { parse_mode: 'HTML' }));
    }

    res.status(statusCode).json({ error });
  };

  /** Извлекает путь или имя файла из stack trace для подписи к блоку кода в Telegram. */
  private getFileLabelFromStack = (stack: string): string => {
    const match = stack.match(/^\s*at\s+(?:.*?\s+)?\(?(.+?):\d+:\d+\)?$/m)
      ?? stack.match(/^\s*at\s+(.+?):\d+:\d+$/m);
    if (!match?.[1]) {
      return 'stack';
    }
    const pathPart = match[1].trim().replace(/^file:\/\//, '');
    const fileName = pathPart.includes('/') ? pathPart.split('/').pop() : pathPart.split('\\').pop();
    return (fileName ?? pathPart).replace(/\s+/g, '-');
  };
}
