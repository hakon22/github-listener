import { Singleton } from 'typescript-ioc';
import winston from 'winston';
import moment from 'moment-timezone';
import DailyRotateFile from 'winston-daily-rotate-file';

@Singleton
export class LoggerService {
  private readonly logDir = '/srv/logs';

  private readonly appName = process.env.APP_NAME ?? 'app';

  private colorizer = winston.format.colorize();

  private readonly levels = {
    critical: 0,
    error: 1,
    warn: 2,
    info: 3,
    verbose: 4,
    debug: 5,
  };

  private readonly colors = {
    critical: 'red',
    error: 'brightRed',
    warn: 'brightRed',
    info: 'brightGreen',
    debug: 'grey',
    verbose: 'green',
  };

  private logger: winston.Logger;

  private transports: winston.transport[];

  public constructor() {
    this.colorizer.addColors(this.colors);
    this.transports = process.env.DB === 'LOCAL' || process.env.CRON
      ? [new winston.transports.Console()]
      : [// Логи в файл с ежедневной ротацией
        new DailyRotateFile({
          dirname: this.logDir,
          filename: `${this.appName}-%DATE%.log`,
          datePattern: 'YYYY-MM-DD',
          zippedArchive: true,
          maxSize: '20m',
          maxFiles: '14d',
          level: 'debug', // Записываем все логи уровня 'debug' и выше
        }),
        // Логи в файл для уровня 'error'
        new DailyRotateFile({
          dirname: this.logDir,
          filename: `${this.appName}-error-%DATE%.log`,
          datePattern: 'YYYY-MM-DD',
          zippedArchive: true,
          maxSize: '20m',
          maxFiles: '14d',
          level: 'error', // Записываем только логи уровня 'error'
        }),
      ];

    this.logger = winston.createLogger({
      level: 'debug',
      levels: this.levels,
      format: winston.format.combine(
        winston.format.timestamp({
          format: () => moment().tz('Europe/Moscow').format(),
        }),
        winston.format.printf(
          (info) => {
            const metadata = `${process.pid} ${info.timestamp} ${info.level}: ${info.module ? `[${info.module}]` : ''}`;
            if (process.env.NODE_ENV === 'production') {
              return `${metadata}${(info.message as string)[0] === '[' ? info.message : ` ${typeof info.message === 'object' ? JSON.stringify(info.message) : info.message}`} ${info.stack ? JSON.stringify(info.stack) : ''}`;
            }
            switch (info.level) {
            case 'critical':
            case 'error':
            case 'debug':
              return this.colorizer.colorize(info.level, `${metadata}${(info.message as string)[0] === '[' ? info.message : ` ${typeof info.message === 'object' ? JSON.stringify(info.message) : info.message}`} ${info.stack ? JSON.stringify(info.stack) : ''}`);
            default:
              return `${this.colorizer.colorize(info.level, metadata)}${(info.message as string)[0] === '[' ? info.message : ` ${typeof info.message === 'object' ? JSON.stringify(info.message) : info.message}`}`;
            }
          },
        ),
      ),
      transports: this.transports,
    });
  }

  private getMeta = (context: any): { module: string; } => ({
    module: context,
  });

  private getArgs = (args: any[], error?: boolean) => {
    const result: any[] = [];

    args.forEach((a) => {
      if (!a) {
        return false;
      }
      if (a && !(typeof a === 'object') && !Array.isArray(a)) {
        result.push(a);
      } else if (a instanceof Error) {
        result.push(a?.stack ? a.stack : a);
      } else {
        result.push((error ? JSON.stringify(a, null, 2) : JSON.stringify(a)));
      }
    });
    return result.join(' ');
  };

  private log = (level: 'error' | 'warn' | 'info' | 'http' | 'verbose' | 'debug' | 'silly', context: string, args: any[], error?: boolean) => {
    const text = this.getArgs(args, error);
    this.logger.log(level, text, this.getMeta(context));
  };

  public info = (message: any, ...args: any[]) => this.log('info', message, args);

  public debug = (message: any, ...args: any[]) => this.log('debug', message, args);

  public warn = (message: any, ...args: any[]) => this.log('warn', message, args);

  public error = (message: any, ...args: any[]) => {
    if (args && args[0]?.type === 'PRECONDITION FAILED') {
      return;
    }
    if (message && (typeof message === 'string')) {
      this.log('error', message, args, true);
    } else if (message?.type !== 'PRECONDITION FAILED') {
      args.push(message);
      this.log('error', '', args, true);
    }
  };
}
