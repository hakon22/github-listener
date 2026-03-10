import type { Request } from 'express';

/** Extended "Express" request object */
export interface RequestExtendedInterface extends Request {
  /** Request unique ID */
  id: string;
  /** Request start date */
  startedAt: number;
}
