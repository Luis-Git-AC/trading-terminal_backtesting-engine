import type { Pool } from 'pg';
import { expectedCandleCount, timeframeToMs, type Candle, type Timeframe } from '@tt/shared';
import { createCandlesRepository } from '../db/repositories/candles.repo.js';
import {
  createGapsRepository,
  NO_DATA_UPSTREAM,
  type GapRecord,
} from '../db/repositories/gaps.repo.js';
import { sleep } from './rate-limiter.js';
import type { CandleFeed } from './backfill.js';

export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_FILL_PAGE_LIMIT = 200;
export const DEFAULT_FILL_MAX_PAGES = 10;
export const DEFAULT_FILL_BATCH = 100;
export const RETRY_BASE_MS = 1000;
export const RETRY_MAX_MS = 60_000;

export type FillOutcome = 'filled' | 'partial' | 'no-data-upstream' | 'failed';

export interface GapFillOptions {
  pool: Pool;
  feed: CandleFeed;
  exchange?: string | undefined;
  symbol?: string | undefined;
  timeframe?: Timeframe | undefined;
  maxAttempts?: number;
  pageLimit?: number;
  maxPages?: number;
  batch?: number;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  log?: GapFillLogger;
}

export interface GapFillResult {
  id: string;
  symbol: string;
  timeframe: Timeframe;
  fromTs: number;
  toTs: number;
  attempts: number;
  fetched: number;
  upserted: number;
  stillMissing: number;
  outcome: FillOutcome;
  error: string | null;
}

export interface GapFillReport {
  results: GapFillResult[];
  filled: number;
  noData: number;
  failed: number;
  elapsedMs: number;
}

export type GapFillEvent =
  | { kind: 'gap'; result: GapFillResult }
  | { kind: 'wait'; id: string; delayMs: number; attempts: number }
  | { kind: 'finish'; report: GapFillReport };

export type GapFillLogger = (event: GapFillEvent) => void;

export function retryDelayMs(attempts: number): number {
  if (attempts <= 0) return 0;
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempts - 1));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function oldestOf(candles: readonly Candle[]): number {
  return candles.reduce((min, candle) => Math.min(min, candle.t), Number.POSITIVE_INFINITY);
}

export async function fillGaps(options: GapFillOptions): Promise<GapFillReport> {
  const {
    pool,
    feed,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    pageLimit = DEFAULT_FILL_PAGE_LIMIT,
    maxPages = DEFAULT_FILL_MAX_PAGES,
    batch = DEFAULT_FILL_BATCH,
    now = Date.now,
    wait = sleep,
    log = (): void => undefined,
  } = options;

  const startedAt = now();
  const candles = createCandlesRepository(pool);
  const gaps = createGapsRepository(pool);

  const pending = await gaps.listFillable({
    exchange: options.exchange,
    symbol: options.symbol,
    timeframe: options.timeframe,
    maxAttempts,
    limit: batch,
  });

  const results: GapFillResult[] = [];

  for (const gap of pending) {
    results.push(await fillOne(gap));
  }

  const report: GapFillReport = {
    results,
    filled: results.filter((result) => result.outcome === 'filled').length,
    noData: results.filter((result) => result.outcome === 'no-data-upstream').length,
    failed: results.filter((result) => result.outcome === 'failed').length,
    elapsedMs: now() - startedAt,
  };

  log({ kind: 'finish', report });
  return report;

  async function fillOne(gap: GapRecord): Promise<GapFillResult> {
    const ref = { exchange: gap.exchange, symbol: gap.symbol, timeframe: gap.timeframe };
    const step = timeframeToMs(gap.timeframe);
    const upperTs = gap.toTs + step;

    const delayMs = retryDelayMs(gap.attempts);
    if (delayMs > 0) {
      log({ kind: 'wait', id: gap.id, delayMs, attempts: gap.attempts });
      await wait(delayMs);
    }

    const attempts = await gaps.registerAttempt(gap.id);

    const base = {
      id: gap.id,
      symbol: gap.symbol,
      timeframe: gap.timeframe,
      fromTs: gap.fromTs,
      toTs: gap.toTs,
      attempts,
    };

    let fetched = 0;
    let upserted = 0;

    try {
      let cursorTs = upperTs;
      let pages = 0;

      while (cursorTs > gap.fromTs && pages < maxPages) {
        const page = await feed.getHistoryCandles({
          symbol: gap.symbol,
          timeframe: gap.timeframe,
          startTime: gap.fromTs,
          endTime: cursorTs,
          limit: pageLimit,
        });

        pages += 1;
        if (page.length === 0) break;

        fetched += page.length;
        const keep = page.filter((candle) => candle.t >= gap.fromTs && candle.t < cursorTs);
        if (keep.length > 0) {
          upserted += await candles.upsertCandles({ ...ref, source: 'rest', candles: keep });
        }

        const nextCursor = Math.max(gap.fromTs, Math.min(oldestOf(page), cursorTs));
        if (nextCursor >= cursorTs) break;
        cursorTs = nextCursor;
      }
    } catch (error) {
      const message = describe(error);
      await gaps.markError({ id: gap.id, lastError: message });
      const result: GapFillResult = {
        ...base,
        fetched,
        upserted,
        stillMissing: expectedCandleCount(gap.fromTs, upperTs, gap.timeframe),
        outcome: 'failed',
        error: message,
      };
      log({ kind: 'gap', result });
      return result;
    }

    const coverage = await candles.getCandles({ ...ref, from: gap.fromTs, to: upperTs });
    const expected = expectedCandleCount(gap.fromTs, upperTs, gap.timeframe);
    const stillMissing = Math.max(0, expected - coverage.length);

    const outcome: FillOutcome =
      stillMissing === 0 ? 'filled' : coverage.length === 0 ? 'no-data-upstream' : 'partial';

    const lastError = stillMissing === 0 ? null : NO_DATA_UPSTREAM;
    await gaps.markFilled({ id: gap.id, lastError });

    const result: GapFillResult = {
      ...base,
      fetched,
      upserted,
      stillMissing,
      outcome,
      error: lastError,
    };
    log({ kind: 'gap', result });
    return result;
  }
}
