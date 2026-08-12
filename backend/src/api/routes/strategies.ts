import type { StrategyCatalog } from '@tt/shared';
import { Router, type Request, type Response } from 'express';
import { buildCatalog } from '../../strategies/registry.js';

export function strategiesRouter(): Router {
  const router = Router();
  const catalog = buildCatalog();

  router.get('/strategies', (_req: Request, res: Response<StrategyCatalog>) => {
    res.json(catalog);
  });

  return router;
}
