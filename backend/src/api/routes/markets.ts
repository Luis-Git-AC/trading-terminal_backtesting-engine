import {
  coverageParamsSchema,
  coverageQuerySchema,
  type CoverageResponse,
  type MarketsResponse,
} from '@tt/shared';
import { Router, type Request, type Response } from 'express';
import { withValidation } from '../middleware/validate.js';
import {
  assertServed,
  getCoverage,
  listMarkets,
  type MarketServiceDeps,
} from '../services/market.service.js';

export function marketsRouter(deps: MarketServiceDeps): Router {
  const router = Router();

  router.get('/markets', (_req: Request, res: Response<MarketsResponse>) => {
    res.json(listMarkets(deps));
  });

  router.get(
    '/markets/:exchange/:symbol/coverage',
    withValidation(
      { params: coverageParamsSchema, query: coverageQuerySchema },
      ({ params, query }, _req, res, next) => {
        try {
          assertServed(deps, params.exchange, params.symbol);
        } catch (error) {
          next(error);
          return;
        }

        getCoverage(deps, params.exchange, params.symbol, query.timeframe)
          .then((coverage: CoverageResponse) => {
            res.json(coverage);
          })
          .catch(next);
      },
    ),
  );

  return router;
}
