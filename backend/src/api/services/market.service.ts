import {
  alignTs,
  expectedCandleCount,
  timeframeToMs,
  type CoverageResponse,
  type MarketsResponse,
  type Timeframe,
} from '@tt/shared';
import type { AppLogger } from '../../observability/logger.js';
import type { CandlesRepository } from '../../db/repositories/candles.repo.js';
import type { IngestStateRepository } from '../../db/repositories/ingest-state.repo.js';
import { COVERAGE_TTL_SEC, cached, coverageKey, type CacheStore } from './cache.js';

export const DEFAULT_PRICE_PRECISION = 1;

export const DEFAULT_QTY_PRECISION = 4;

export interface MarketServiceDeps {
  readonly candles: CandlesRepository;
  readonly ingestState: IngestStateRepository;
  readonly cache: CacheStore;
  readonly logger: AppLogger;
  readonly exchange: string;
  readonly symbols: readonly string[];
  readonly timeframes: readonly Timeframe[];
  readonly now: () => number;
  readonly precision?: Record<string, { price: number; qty: number }>;
}

function toIso(ts: number | null): string | null {
  return ts === null ? null : new Date(ts).toISOString();
}

export function listMarkets(deps: MarketServiceDeps): MarketsResponse {
  return {
    exchange: deps.exchange,
    symbols: deps.symbols.map((symbol) => {
      const precision = deps.precision?.[symbol];
      return {
        symbol,
        timeframes: [...deps.timeframes],
        pricePrecision: precision?.price ?? DEFAULT_PRICE_PRECISION,
        qtyPrecision: precision?.qty ?? DEFAULT_QTY_PRECISION,
      };
    }),
  };
}

export async function getCoverage(
  deps: MarketServiceDeps,
  symbol: string,
  timeframe: Timeframe,
): Promise<CoverageResponse> {
  return cached<CoverageResponse>({
    cache: deps.cache,
    logger: deps.logger,
    key: coverageKey(symbol, timeframe),
    ttlSec: COVERAGE_TTL_SEC,
    parse: (raw) => JSON.parse(raw) as CoverageResponse,
    load: async () => {
      const series = { symbol, timeframe };
      const [coverage, state] = await Promise.all([
        deps.candles.getCoverage(series),
        deps.ingestState.get(series),
      ]);

      if (coverage.fromTs === null || coverage.toTs === null) {
        return {
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
