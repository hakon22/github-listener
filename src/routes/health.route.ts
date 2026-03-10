import type { Router, Request, Response } from 'express';
import { Singleton } from 'typescript-ioc';

import { BaseRouter } from '@/routes/base.route';

@Singleton
export class HealthRoute extends BaseRouter {
  public set(router: Router): void {
    router.get('/api/v1/status/healthcheck', (_request: Request, response: Response) => {
      response.status(200).json({ status: 'ok' });
    });
  }
}

