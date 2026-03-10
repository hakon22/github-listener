import type { Router } from 'express';

export abstract class BaseRouter {
  public abstract set(router: Router): void;
}

