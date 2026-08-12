import { candlesQuerySchema, type CandlesResponse } from '@tt/shared';
import { Router } from 'express';
import { AppError } from '../errors.js';
import { withValidation } from '../middleware/validate.js';
import { getCandles, type CandlesServiceDeps } from '../services/candles.service.js';

export interface CandlesRouterDeps extends CandlesServiceDeps {
  readonly symbols: readonly string[];
}

export function candlesRouter(deps: CandlesRouterDeps): Router {
  const router = Router();

  router.get(
    '/candles',
    withValidation({ query: candlesQuerySchema }, ({ query }, _req, res, next) => {
      if (!deps.symbols.includes(query.symbol)) {
        next(AppError.notFound(`Simbolo no disponible: ${query.symbol}`));
        return;
      }

      getCandles(deps, {
        symbol: query.symbol,
        timeframe: query.timeframe,
        from: query.from,
        to: query.to,
        limit: query.limit,
      })
        .then((payload: CandlesResponse) => {
          res.json(payload);
        })
        .catch(next);
    }),
  );

  return router;
}
