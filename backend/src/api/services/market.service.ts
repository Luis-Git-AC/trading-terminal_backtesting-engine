import {
  alignTs,
  expectedCandleCount,
  timeframeToMs,
  type CoverageResponse,
  type Exchange,
  type MarketsResponse,
  type Timeframe,
} from '@tt/shared';
import type { AppLogger } from '../../observability/logger.js';
import type { CandlesRepository } from '../../db/repositories/candles.repo.js';
import type { IngestStateRepository } from '../../db/repositories/ingest-state.repo.js';
import { AppError } from '../errors.js';
import { COVERAGE_TTL_SEC, cached, coverageKey, type CacheStore } from './cache.js';

export const DEFAULT_PRICE_PRECISION = 1;

export const DEFAULT_QTY_PRECISION = 4;

export interface Precision {
  price: number;
  qty: number;
}

/**
 * Decimales por `exchange/symbol`. Cuanto mas barato es el subyacente, mas decimales
 * necesita el precio y menos el tamano.
 */
export const SYMBOL_PRECISION: Record<string, Precision> = {
  'bitget/BTCUSDT': { price: 1, qty: 4 },
  'bitget/ETHUSDT': { price: 2, qty: 3 },
  'bitget/SOLUSDT': { price: 3, qty: 2 },
};

export function precisionKey(exchange: string, symbol: string): string {
  return `${exchange}/${symbol}`;
}

export interface MarketExchangeDeps {
  readonly exchange: Exchange;
  readonly symbols: readonly string[];
}

export interface MarketCatalog {
  readonly exchanges: readonly MarketExchangeDeps[];
}

export interface MarketServiceDeps extends MarketCatalog {
  readonly candles: CandlesRepository;
  readonly ingestState: IngestStateRepository;
  readonly cache: CacheStore;
  readonly logger: AppLogger;
  readonly timeframes: readonly Timeframe[];
  readonly now: () => number;
  readonly precision?: Record<string, Precision>;
}

function toIso(ts: number | null): string | null {
  return ts === null ? null : new Date(ts).toISOString();
}

export function symbolsOf(catalog: MarketCatalog, exchange: string): readonly string[] {
  return catalog.exchanges.find((item) => item.exchange === exchange)?.symbols ?? [];
}

export function serves(catalog: MarketCatalog, exchange: string, symbol: string): boolean {
  return symbolsOf(catalog, exchange).includes(symbol);
}

export function assertServed(catalog: MarketCatalog, exchange: string, symbol: string): void {
  if (!catalog.exchanges.some((item) => item.exchange === exchange)) {
    throw new AppError('UNKNOWN_EXCHANGE', `Exchange no servido: ${exchange}`);
  }
  if (!serves(catalog, exchange, symbol)) {
    throw AppError.notFound(`Simbolo no disponible en ${exchange}: ${symbol}`);
  }
}

export function listMarkets(deps: MarketServiceDeps): MarketsResponse {
  return {
    exchanges: deps.exchanges.map((item) => ({
      exchange: item.exchange,
      symbols: item.symbols.map((symbol) => {
        const key = precisionKey(item.exchange, symbol);
        const precision = deps.precision?.[key] ?? SYMBOL_PRECISION[key];
        return {
          symbol,
          timeframes: [...deps.timeframes],
          pricePrecision: precision?.price ?? DEFAULT_PRICE_PRECISION,
          qtyPrecision: precision?.qty ?? DEFAULT_QTY_PRECISION,
        };
      }),
    })),
  };
}

export async function getCoverage(
  deps: MarketServiceDeps,
  exchange: Exchange,
  symbol: string,
  timeframe: Timeframe,
): Promise<CoverageResponse> {
  return cached<CoverageResponse>({
    cache: deps.cache,
    logger: deps.logger,
    key: coverageKey(exchange, symbol, timeframe),
    ttlSec: COVERAGE_TTL_SEC,
    parse: (raw) => JSON.parse(raw) as CoverageResponse,
    load: async () => {
      const series = { exchange, symbol, timeframe };
      const [coverage, state] = await Promise.all([
        deps.candles.getCoverage(series),
        deps.ingestState.get(series),
      ]);

      if (coverage.fromTs === null || coverage.toTs === null) {
        return {
          exchange,
          symbol,
          timeframe,
          from: null,
          to: null,
          candles: 0,
          expected: 0,
          missing: 0,
          gaps: [],
          backfill: {
            done: state?.backfillDone ?? false,
            cursor: toIso(state?.backfillCursorTs ?? null),
          },
        };
      }

      const step = timeframeToMs(timeframe);
      const upper = alignTs(coverage.toTs, timeframe) + step;
      const expected = expectedCandleCount(coverage.fromTs, upper, timeframe);
      const gaps = await deps.candles.findGaps({ ...series, from: coverage.fromTs, to: upper });

      return {
        exchange,
        symbol,
        timeframe,
        from: toIso(coverage.fromTs),
        to: toIso(coverage.toTs),
        candles: coverage.rows,
        expected,
        missing: Math.max(0, expected - coverage.rows),
        gaps: gaps.map((gap) => ({
          from: new Date(gap.fromTs).toISOString(),
          to: new Date(gap.toTs).toISOString(),
          filled: false,
        })),
        backfill: {
          done: state?.backfillDone ?? false,
          cursor: toIso(state?.backfillCursorTs ?? null),
        },
      };
    },
  });
}
