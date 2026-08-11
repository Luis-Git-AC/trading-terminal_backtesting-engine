import type { Pool } from 'pg';
import { alignTs, expectedCandleCount, timeframeToMs, type Candle, type Timeframe } from '@tt/shared';
import { createCandlesRepository } from '../db/repositories/candles.repo.js';
import { createGapsRepository } from '../db/repositories/gaps.repo.js';
import type { CandleFeed } from './backfill.js';

export const DEFAULT_RECONCILE_PAGE_LIMIT = 200;
export const DEFAULT_RECONCILE_MAX_PAGES = 10;

export type ReconcileStop =
  | 'no-anchor'
  | 'up-to-date'
  | 'complete'
  | 'no-more-data'
  | 'no-progress'
  | 'gap-too-large';

export interface ReconcileOptions {
  pool: Pool;
  feed: CandleFeed;
  exchange?: string | undefined;
  symbol: string;
  timeframe: Timeframe;
  to?: number | undefined;
  pageLimit?: number | undefined;
  maxPages?: number | undefined;
  now?: () => number;
  log?: ReconcileLogger;
}

export interface ReconcileReport {
  symbol: string;
  timeframe: Timeframe;
  lastCandleTs: number | null;
  upperTs: number;
  missingBefore: number;
  pages: number;
  fetched: number;
  upserted: number;
  gap: { fromTs: number; toTs: number } | null;
  stoppedBy: ReconcileStop;
  elapsedMs: number;
}

export type ReconcileEvent =
  | {
      kind: 'start';
      symbol: string;
      timeframe: Timeframe;
      lastCandleTs: number | null;
      upperTs: number;
      missing: number;
    }
  | { kind: 'gap'; symbol: string; timeframe: Timeframe; fromTs: number; toTs: number; missing: number }
  | { kind: 'finish'; report: ReconcileReport };

export type ReconcileLogger = (event: ReconcileEvent) => void;

function oldestOf(candles: readonly Candle[]): number {
  return candles.reduce((min, candle) => Math.min(min, candle.t), Number.POSITIVE_INFINITY);
}

export async function reconcileSeries(options: ReconcileOptions): Promise<ReconcileReport> {
  const {
    pool,
    feed,
    symbol,
    timeframe,
    now = Date.now,
    log = (): void => undefined,
    pageLimit = DEFAULT_RECONCILE_PAGE_LIMIT,
    maxPages = DEFAULT_RECONCILE_MAX_PAGES,
  } = options;

  const series = { exchange: options.exchange, symbol, timeframe };
  const step = timeframeToMs(timeframe);
  const startedAt = now();

  const candles = createCandlesRepository(pool);
  const upperTs = alignTs(options.to ?? now(), timeframe);
  const lastCandleTs = await candles.getLastCandleTs(series);

  function finish(
    stoppedBy: ReconcileStop,
    partial: Partial<ReconcileReport> = {},
  ): ReconcileReport {
    const report: ReconcileReport = {
      symbol,
      timeframe,
      lastCandleTs,
      upperTs,
      missingBefore: 0,
      pages: 0,
      fetched: 0,
      upserted: 0,
      gap: null,
      stoppedBy,
      elapsedMs: now() - startedAt,
      ...partial,
    };
    log({ kind: 'finish', report });
    return report;
  }

  if (lastCandleTs === null) return finish('no-anchor');

  const missingBefore =
    lastCandleTs >= upperTs ? 0 : expectedCandleCount(lastCandleTs + step, upperTs, timeframe);

  if (missingBefore === 0) return finish('up-to-date');

  log({ kind: 'start', symbol, timeframe, lastCandleTs, upperTs, missing: missingBefore });

  if (missingBefore > maxPages * pageLimit) {
    const gapFrom = lastCandleTs + step;
    const gapTo = upperTs - step;
    await createGapsRepository(pool).recordGap({ ...series, fromTs: gapFrom, toTs: gapTo });
    log({ kind: 'gap', symbol, timeframe, fromTs: gapFrom, toTs: gapTo, missing: missingBefore });
    return finish('gap-too-large', {
      missingBefore,
      gap: { fromTs: gapFrom, toTs: gapTo },
    });
  }

  let cursorTs = upperTs;
  let pages = 0;
  let fetched = 0;
  let upserted = 0;
  let stoppedBy: ReconcileStop = 'complete';

  while (cursorTs > lastCandleTs && pages < maxPages) {
    const page = await feed.getHistoryCandles({
      symbol,
      timeframe,
      startTime: lastCandleTs,
      endTime: cursorTs,
      limit: pageLimit,
    });

    pages += 1;

    if (page.length === 0) {
      stoppedBy = 'no-more-data';
      break;
    }

    fetched += page.length;

    const keep = page.filter((candle) => candle.t >= lastCandleTs && candle.t < cursorTs);
    if (keep.length > 0) {
      upserted += await candles.upsertCandles({ ...series, source: 'rest', candles: keep });
    }

    const nextCursor = Math.max(lastCandleTs, Math.min(oldestOf(page), cursorTs));
    if (nextCursor >= cursorTs) {
      stoppedBy = 'no-progress';
      break;
    }

    cursorTs = nextCursor;
  }

  return finish(stoppedBy, { missingBefore, pages, fetched, upserted });
}
