import {
  coverageParamsSchema,
  coverageQuerySchema,
  type CoverageResponse,
  type MarketsResponse,
} from '@tt/shared';
import { Router, type Request, type Response } from 'express';
import { AppError } from '../errors.js';
import { withValidation } from '../middleware/validate.js';
import { getCoverage, listMarkets, type MarketServiceDeps } from '../services/market.service.js';

export function marketsRouter(deps: MarketServiceDeps): Router {
  const router = Router();

  router.get('/markets', (_req: Request, res: Response<MarketsResponse>) => {
    res.json(listMarkets(deps));
  });

  router.get(
    '/markets/:symbol/coverage',
    withValidation(
      { params: coverageParamsSchema, query: coverageQuerySchema },
      ({ params, query }, _req, res, next) => {
        if (!deps.symbols.includes(params.symbol)) {
          next(AppError.notFound(`Simbolo no disponible: ${params.symbol}`));
          return;
        }

        getCoverage(deps, params.symbol, query.timeframe)
          .then((coverage: CoverageResponse) => {
            res.json(coverage);
          })
          .catch(next);
      },
    ),
  );

  return router;
}
