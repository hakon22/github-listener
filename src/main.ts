import 'dotenv/config';
import 'reflect-metadata';

import express from 'express';
import { Container } from 'typescript-ioc';
import bodyParser from 'body-parser';

import { TelegramBotService } from '@/services/notifications/telegram-bot.service';
import { RouterService } from '@/services/core/router.service';
import { LoggerService } from '@/services/core/logger.service';

class Main {

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
        `Received GitHub/GitLab webhook:\n${buf.toString(<BufferEncoding>encoding)}`,
      ),
    }));
    this.app.use(express.json());

    this.routerService.set();
    this.app.use(this.routerService.get());
  };

  public async start(): Promise<void> {
    await this.telegramBotService.init();

    const bot = this.telegramBotService.getBot();

    this.configureExpress();

    this.app.listen(this.port, () => {
      console.log(`GitLab/GitHub webhook server is running on port ${this.port}`);
    });

    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
  }
}

new Main()
  .start()
  .catch((e: unknown) => {
    console.error(e);
  });

