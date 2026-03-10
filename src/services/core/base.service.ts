import { Container } from 'typescript-ioc';
import type { Response } from 'express';

import { LoggerService } from '@/services/core/logger.service';
import { TelegramService } from '@/services/notifications/telegram.service';

export abstract class BaseService {
  protected loggerService = Container.get(LoggerService);

  protected telegramService = Container.get(TelegramService);

  protected defer = (task: () => Promise<void> | void): void => {
    setImmediate(async () => {
      try {
        await task();
      } catch (error) {
        const errorInstance = error as Error;

        this.loggerService.error('Unhandled error in deferred task', {
          error: {
            name: errorInstance?.name || String(error),
            message: errorInstance?.message || String(error),
            stack: errorInstance?.stack,
          },
        });
      }
    });
  };

  protected logWebhookProcessed = (providerName: 'GitHub' | 'GitLab', eventName: string, extras: Record<string, unknown>): void => {
    this.loggerService.info(`${providerName} ${eventName} event processed and notification sent`, {
      extras,
    });
  };

  protected handleWebhookProcessingError = (providerName: 'GitHub' | 'GitLab', error: unknown, response: Response): Response => {
    const errorInstance = error as Error;

    this.loggerService.error(`Error ocurred during ${providerName} webhook processing`, {
      error: {
        name: errorInstance?.name || String(error),
        message: errorInstance?.message || String(error),
        stack: errorInstance?.stack,
      },
    });

    this.errorHandler(error, response);
    return response;
  };

  protected errorHandler = (e: any, res: Response, statusCode = 500) => {
    this.loggerService.error(String(e));

    let error = `${e?.name}: ${e?.message}`;

    if (e?.name === 'ValidationError') {
      error = `${e?.name}: "${e?.path}" ${e?.message}`;
    }

    if (e instanceof Error && e.stack && process.env.TELEGRAM_CHAT_ID && process.env.NODE_ENV === 'production') {
      const message = [
        `Ошибка на сервере <b>${process.env.APP_NAME}</b>:`,
        `<pre><code class="language-typescript">${e.stack}</code></pre>`,
      ];

      this.defer(() => this.telegramService.sendAdminMessage(message, { parse_mode: 'HTML' }));
    }

    res.status(statusCode).json({ error });
  };
}
