import type { Request, Response } from 'express';
import { Container } from 'typescript-ioc';

import { GitlabWebhookController } from '@/controllers/gitlab-webhook.controller';
import gitlabPushPayload from './fixtures/gitlab-push.payload.json';
import gitlabMergeRequestPayload from './fixtures/gitlab-merge-request.payload.json';
import { GitlabAgentService } from '@/services/scm/agents/gitlab-agent.service';
import { CodeAnalyzerService } from '@/services/analysis/code-analyzer.service';
import { AIService } from '@/services/analysis/ai.service';
import { VectorStoreService } from '@/services/analysis/vector-store.service';
import { TelegramService } from '@/services/notifications/telegram.service';
import { LoggerService } from '@/services/core/logger.service';

jest.mock('@/services/scm/agents/gitlab-agent.service', () => ({
  GitlabAgentService: class GitlabAgentService {},
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

describe('GitlabWebhookController', () => {
  beforeEach(() => {
    const loggerServiceStub = {
      error: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
    } as unknown as LoggerService;

    const dependencies = new Map<unknown, unknown>([
      [GitlabAgentService, {}],
      [CodeAnalyzerService, {}],
      [AIService, {}],
      [VectorStoreService, {}],
      [TelegramService, {}],
      [LoggerService, loggerServiceStub],
    ]);

    (Container.get as jest.Mock).mockImplementation((token: unknown) => dependencies.get(token) ?? {});
  });

  it('returns processing for GitLab push events and defers handling', async () => {
    const controller = new GitlabWebhookController();
    const handlePushSpy = jest.spyOn(
      controller as unknown as { handlePush: () => Promise<void>; },
      'handlePush',
    ).mockResolvedValue(undefined);

    const request = {
      body: gitlabPushPayload,
    } as Request;
    const response = createResponse();

    controller.onWebhookMessage(request, response);

    await new Promise<void>((resolve) => {
      setImmediate(() => resolve());
    });

    expect((response as unknown as { statusCode: number; }).statusCode).toBe(200);
    expect((response as unknown as { payload: unknown; }).payload).toEqual({ status: 'processing' });
    expect(handlePushSpy).toHaveBeenCalledTimes(1);
    expect(handlePushSpy).toHaveBeenCalledWith(gitlabPushPayload);
  });

  it('returns processing for GitLab merge request events and defers handling', async () => {
    const controller = new GitlabWebhookController();
    const handleMergeRequestSpy = jest.spyOn(
      controller as unknown as { handleMergeRequest: () => Promise<void>; },
      'handleMergeRequest',
    ).mockResolvedValue(undefined);

    const request = {
      body: gitlabMergeRequestPayload,
    } as Request;
    const response = createResponse();

    controller.onWebhookMessage(request, response);

    await new Promise<void>((resolve) => {
      setImmediate(() => resolve());
    });

    expect((response as unknown as { statusCode: number; }).statusCode).toBe(200);
    expect((response as unknown as { payload: unknown; }).payload).toEqual({ status: 'processing' });
    expect(handleMergeRequestSpy).toHaveBeenCalledTimes(1);
    expect(handleMergeRequestSpy).toHaveBeenCalledWith(gitlabMergeRequestPayload);
  });
});

