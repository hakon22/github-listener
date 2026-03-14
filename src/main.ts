import 'dotenv/config';
import 'reflect-metadata';

import express from 'express';
import { Container } from 'typescript-ioc';
import bodyParser from 'body-parser';

import { TelegramBotService } from '@/services/notifications/telegram-bot.service';
import { RouterService } from '@/services/core/router.service';
import { LoggerService } from '@/services/core/logger.service';

class Main {
  private readonly TAG = 'Main';

  private readonly telegramBotService = Container.get(TelegramBotService);

  private readonly routerService = Container.get(RouterService);

  private readonly loggerService = Container.get(LoggerService);

  private readonly app = express();

  private readonly port = Number(process.env.PORT ?? 3013);

  private readonly isProduction = process.env.NODE_ENV === 'production';

  private configureExpress = (): void => {
    this.app.use(bodyParser.json({
      limit: '50mb',
      strict: false,
      verify: (_req, _res, buf, encoding) => this.loggerService.debug(
        this.TAG,
        `Received GitHub/GitLab webhook:\n${buf.toString(<BufferEncoding>encoding)}`,
      ),
    }));
    this.app.use(express.json());

    this.routerService.set();
    this.app.use(this.routerService.get());
  };

  public async start(): Promise<void> {
    this.loggerService.info(this.TAG, 'Starting application...');

    await this.telegramBotService.init();

    const bot = this.telegramBotService.getBot();

    this.configureExpress();

    this.app.listen(this.port, () => {
      this.loggerService.info(this.TAG, `GitLab/GitHub webhook server is running on port ${this.port}`);
    });

    const shutdown = (signal: string) => {
      this.loggerService.info(this.TAG, `Received ${signal}, shutting down`);
      try {
        bot.stop(signal);
      } catch (error) {
        const errorInstance = error as Error;
        if (errorInstance.message !== 'Bot is not running!') {
          this.loggerService.error(this.TAG, 'Error stopping bot', errorInstance);
        }
      }
      process.exit(0);
    };

    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
  }
}

new Main()
  .start()
  .catch((error: unknown) => {
    try {
      Container.get(LoggerService).error('Main', 'Application failed to start', error);
    } catch {
      console.error('Application failed to start', error);
    }
    process.exit(1);
  });

