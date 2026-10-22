import { candlesQuerySchema, type CandlesResponse } from '@tt/shared';
import { Router } from 'express';
import { withValidation } from '../middleware/validate.js';
import { getCandles, type CandlesServiceDeps } from '../services/candles.service.js';
import { assertServed, type MarketCatalog } from '../services/market.service.js';

export interface CandlesRouterDeps extends CandlesServiceDeps {
  readonly markets: MarketCatalog;
}

export function candlesRouter(deps: CandlesRouterDeps): Router {
  const router = Router();

  router.get(
    '/candles',
    withValidation({ query: candlesQuerySchema }, ({ query }, _req, res, next) => {
      try {
        assertServed(deps.markets, query.exchange, query.symbol);
      } catch (error) {
        next(error);
        return;
      }

      getCandles(deps, {
        exchange: query.exchange,
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
