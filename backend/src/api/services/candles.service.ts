import {
  CANDLES_MAX_LIMIT,
  timeframeToMs,
  type CandlesResponse,
  type Timeframe,
} from '@tt/shared';
import type { CandlesRepository } from '../../db/repositories/candles.repo.js';
import type { AppLogger } from '../../observability/logger.js';
import { AppError } from '../errors.js';
import {
  CANDLES_TTL_CLOSED_SEC,
  CANDLES_TTL_OPEN_SEC,
  cached,
  candlesKey,
  type CacheStore,
} from './cache.js';

export interface CandlesServiceDeps {
  readonly candles: CandlesRepository;
  readonly cache: CacheStore;
  readonly logger: AppLogger;
  readonly now: () => number;
}

export interface CandlesRequest {
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly from: number;
  readonly to?: number | undefined;
  readonly limit?: number | undefined;
}

export function ttlForRange(to: number, now: number, timeframe: Timeframe): number {
  const currentCandleOpen = now - (now % timeframeToMs(timeframe));
  return to > currentCandleOpen ? CANDLES_TTL_OPEN_SEC : CANDLES_TTL_CLOSED_SEC;
}

export async function getCandles(
  deps: CandlesServiceDeps,
  request: CandlesRequest,
): Promise<CandlesResponse> {
  const limit = request.limit ?? CANDLES_MAX_LIMIT;

  if (limit > CANDLES_MAX_LIMIT) {
    throw AppError.rangeTooLarge(
      `limit maximo ${CANDLES_MAX_LIMIT}, se pidieron ${limit}`,
    );
  }

  const to = request.to ?? deps.now();

  if (to <= request.from) {
    throw AppError.validation('El rango esta vacio', [
      { path: 'query.to', message: 'to debe ser mayor que from' },
    ]);
  }

  const step = timeframeToMs(request.timeframe);

  return cached<CandlesResponse>({
    cache: deps.cache,
    logger: deps.logger,
    key: candlesKey(request.symbol, request.timeframe, request.from, to, limit),
    ttlSec: ttlForRange(to, deps.now(), request.timeframe),
    parse: (raw) => JSON.parse(raw) as CandlesResponse,
    load: async () => {
      const rows = await deps.candles.getCandles({
        symbol: request.symbol,
        timeframe: request.timeframe,
        from: request.from,
        to,
        limit,
      });

      const last = rows[rows.length - 1];
      const nextFrom = rows.length === limit && last !== undefined ? last.t + step : null;

      return {
        symbol: request.symbol,
        timeframe: request.timeframe,
        count: rows.length,
        candles: rows.map((candle) => ({
          t: candle.t,
          o: candle.o,
          h: candle.h,
          l: candle.l,
          c: candle.c,
          v: candle.v,
        })),
        nextFrom,
      };
    },
  });
}
