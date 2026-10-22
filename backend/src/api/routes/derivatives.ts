import {
  CANDLES_MAX_LIMIT,
  derivativesParamsSchema,
  derivativesQuerySchema,
  type FundingResponse,
  type OpenInterestResponse,
} from '@tt/shared';
import { Router } from 'express';
import { AppError } from '../errors.js';
import { withValidation } from '../middleware/validate.js';
import type { DerivativesRepository } from '../../db/repositories/derivatives.repo.js';
import { assertServed, type MarketCatalog } from '../services/market.service.js';

export interface DerivativesRouterDeps {
  readonly derivatives: DerivativesRepository;
  readonly markets: MarketCatalog;
  readonly now?: () => number;
}

interface Range {
  readonly from: number;
  readonly to: number;
  readonly limit: number;
}

/** Mismo contrato de rango y limite que `/api/candles`: semiabierto y con tope duro. */
function range(
  query: { from: number; to?: number | undefined; limit?: number | undefined },
  now: () => number,
): Range {
  const limit = query.limit ?? CANDLES_MAX_LIMIT;
  if (limit > CANDLES_MAX_LIMIT) {
    throw new AppError(
      'VALIDATION_ERROR',
      `limit maximo ${CANDLES_MAX_LIMIT}, se pidieron ${limit}`,
    );
  }

  const to = query.to ?? now();
  if (to <= query.from) {
    throw new AppError('VALIDATION_ERROR', 'to debe ser posterior a from');
  }

  return { from: query.from, to, limit };
}

function nextFromOf(rows: readonly { t: number }[], limit: number): number | null {
  const last = rows.at(-1);
  return rows.length === limit && last !== undefined ? last.t + 1 : null;
}

export function derivativesRouter(deps: DerivativesRouterDeps): Router {
  const router = Router();
  const now = deps.now ?? ((): number => Date.now());

  router.get(
    '/derivatives/:exchange/:symbol/funding',
    withValidation(
      { params: derivativesParamsSchema, query: derivativesQuerySchema },
      ({ params, query }, _req, res, next) => {
        let scope: Range;
        try {
          assertServed(deps.markets, params.exchange, params.symbol);
          scope = range(query, now);
        } catch (error) {
          next(error);
          return;
        }

        deps.derivatives
          .getFundingRates({ ...params, ...scope })
          .then((funding) => {
            const payload: FundingResponse = {
              exchange: params.exchange,
              symbol: params.symbol,
              count: funding.length,
              funding,
              nextFrom: nextFromOf(funding, scope.limit),
            };
            res.json(payload);
          })
          .catch(next);
      },
    ),
  );

  router.get(
    '/derivatives/:exchange/:symbol/open-interest',
    withValidation(
      { params: derivativesParamsSchema, query: derivativesQuerySchema },
      ({ params, query }, _req, res, next) => {
        let scope: Range;
        try {
          assertServed(deps.markets, params.exchange, params.symbol);
          scope = range(query, now);
        } catch (error) {
          next(error);
          return;
        }

        deps.derivatives
          .getOpenInterest({ ...params, ...scope })
          .then((openInterest) => {
            const payload: OpenInterestResponse = {
              exchange: params.exchange,
              symbol: params.symbol,
              count: openInterest.length,
              openInterest,
              nextFrom: nextFromOf(openInterest, scope.limit),
            };
            res.json(payload);
          })
          .catch(next);
      },
    ),
  );

  return router;
}
