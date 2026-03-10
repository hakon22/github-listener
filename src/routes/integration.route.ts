import { Container, Singleton } from 'typescript-ioc';
import type { Router, Request, Response } from 'express';

import { GitlabWebhookController } from '@/controllers/gitlab-webhook.controller';
import { GithubWebhookController } from '@/controllers/github-webhook.controller';
import { BaseRouter } from '@/routes/base.route';

@Singleton
export class IntegrationRoute extends BaseRouter {
  private readonly gitlabController = Container.get(GitlabWebhookController);

  private readonly githubController = Container.get(GithubWebhookController);

  public set(router: Router): void {
    router.post('/api/v1/gitlab/webhook', (req: Request, res: Response) => this.gitlabController.onWebhookMessage(req, res));
    router.post('/api/v1/github/webhook', (req: Request, res: Response) => this.githubController.onWebhookMessage(req, res));
  }
}

