import type { Request, Response } from 'express';
import { Container } from 'typescript-ioc';

import { GithubWebhookController } from '@/controllers/github-webhook.controller';
import { GithubAgent } from '@/services/scm/agents/github-agent.service';
import { CodeAnalyzerService } from '@/services/analysis/code-analyzer.service';
import { AIService } from '@/services/analysis/ai.service';
import { VectorStoreService } from '@/services/analysis/vector-store.service';
import { TelegramService } from '@/services/notifications/telegram.service';
import { LoggerService } from '@/services/core/logger.service';

jest.mock('@/services/scm/agents/github-agent.service', () => ({
  GithubAgent: class GithubAgent {},
}));
jest.mock('@/services/analysis/code-analyzer.service', () => ({
  CodeAnalyzerService: class CodeAnalyzerService {},
}));
jest.mock('@/services/analysis/ai.service', () => ({
  AIService: class AIService {},
}));
jest.mock('@/services/analysis/vector-store.service', () => ({
  VectorStoreService: class VectorStoreService {},
}));
jest.mock('@/services/notifications/telegram.service', () => ({
  TelegramService: class TelegramService {},
}));
jest.mock('@/services/core/logger.service', () => ({
  LoggerService: class LoggerService {},
}));

jest.mock('typescript-ioc', () => ({
  Container: {
    get: jest.fn(),
  },
  Singleton: (target: unknown) => target,
  Inject: () => undefined,
}));

const createResponse = (): Response => {
  const response = {
    statusCode: 0,
    payload: null as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.payload = body;
      return this;
    },
  };

  return response as unknown as Response;
};

describe('GithubWebhookController', () => {
  beforeEach(() => {
    const loggerServiceStub = {
      error: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
    } as unknown as LoggerService;

    const dependencies = new Map<unknown, unknown>([
      [GithubAgent, {}],
      [CodeAnalyzerService, {}],
      [AIService, {}],
      [VectorStoreService, {}],
      [TelegramService, {}],
      [LoggerService, loggerServiceStub],
    ]);

    (Container.get as jest.Mock).mockImplementation((token: unknown) => dependencies.get(token) ?? {});
  });

  it('returns processing for GitHub push events and defers handling', async () => {
    const controller = new GithubWebhookController();
    const handlePushSpy = jest.spyOn(
      controller as unknown as { handlePush: () => Promise<void>; },
      'handlePush',
    ).mockResolvedValue(undefined);

    const request = {
      headers: {
        'x-github-event': 'push',
      },
      body: {},
    } as unknown as Request;
    const response = createResponse();

    controller.onWebhookMessage(request, response);

    await new Promise<void>((resolve) => {
      setImmediate(() => resolve());
    });

    expect((response as unknown as { statusCode: number; }).statusCode).toBe(200);
    expect((response as unknown as { payload: unknown; }).payload).toEqual({ status: 'processing' });
    expect(handlePushSpy).toHaveBeenCalledTimes(1);
  });

  it('returns processing for GitHub pull request events and defers handling', async () => {
    const controller = new GithubWebhookController();
    const handlePullRequestSpy = jest.spyOn(
      controller as unknown as { handlePullRequest: () => Promise<void>; },
      'handlePullRequest',
    ).mockResolvedValue(undefined);

    const request = {
      headers: {
        'x-github-event': 'pull_request',
      },
      body: {},
    } as unknown as Request;
    const response = createResponse();

    controller.onWebhookMessage(request, response);

    await new Promise<void>((resolve) => {
      setImmediate(() => resolve());
    });

    expect((response as unknown as { statusCode: number; }).statusCode).toBe(200);
    expect((response as unknown as { payload: unknown; }).payload).toEqual({ status: 'processing' });
    expect(handlePullRequestSpy).toHaveBeenCalledTimes(1);
  });
}
);

