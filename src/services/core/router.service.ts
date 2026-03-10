import { Singleton, Container } from 'typescript-ioc';
import express from 'express';

import { BaseRouter } from '@/routes/base.route';
import { IntegrationRoute } from '@/routes/integration.route';
import { HealthRoute } from '@/routes/health.route';

@Singleton
export class RouterService extends BaseRouter {
  private readonly integrationRoute = Container.get(IntegrationRoute);

  private readonly healthRoute = Container.get(HealthRoute);

  private router = express.Router();

  private routesArray = [
    this.integrationRoute,
    this.healthRoute,
  ];

  public set = () => this.routesArray.forEach((route) => route.set(this.router));

  public get = () => this.router;
}
