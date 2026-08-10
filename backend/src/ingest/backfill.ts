import type { Pool } from 'pg';
import { alignTs, expectedCandleCount, type Candle, type Timeframe } from '@tt/shared';
import { createCandlesRepository } from '../db/repositories/candles.repo.js';
import { createIngestStateRepository } from '../db/repositories/ingest-state.repo.js';

const DEFAULT_PROGRESS_EVERY_PAGES = 10;

export type BackfillStop = 'target-reached' | 'no-more-data' | 'no-progress' | 'max-pages';

export interface CandleFeedQuery {
  symbol: string;
  timeframe: Timeframe;
  startTime?: number | undefined;
  endTime?: number | undefined;
  limit?: number | undefined;
}

export interface CandleFeed {
  getHistoryCandles(query: CandleFeedQuery): Promise<Candle[]>;
}

export interface BackfillOptions {
  pool: Pool;
  feed: CandleFeed;
  exchange?: string;
  symbol: string;
  timeframe: Timeframe;
  from: number;
  to?: number | undefined;
  pageLimit?: number | undefined;
  maxPages?: number | undefined;
  progressEveryPages?: number;
  now?: () => number;
  log?: BackfillLogger;
}

export interface BackfillReport {
  symbol: string;
  timeframe: Timeframe;
  targetTs: number;
  startedFromTs: number;
  reachedTs: number;
  pages: number;
  fetched: number;
  upserted: number;
  done: boolean;
  stoppedBy: BackfillStop;
  elapsedMs: number;
}

export type BackfillEvent =
  | {
      kind: 'start';
      symbol: string;
      timeframe: Timeframe;
      targetTs: number;
      cursorTs: number;
      resumed: boolean;
    }
  | {
      kind: 'progress';
      pages: number;
      fetched: number;
      upserted: number;
      cursorTs: number;
      candlesPerSecond: number;
      remaining: number;
      etaMs: number | null;
    }
  | { kind: 'finish'; report: BackfillReport };

export type BackfillLogger = (event: BackfillEvent) => void;

function oldestOf(candles: readonly Candle[]): number {
  return candles.reduce((min, candle) => Math.min(min, candle.t), Number.POSITIVE_INFINITY);
}

export async function backfillSeries(options: BackfillOptions): Promise<BackfillReport> {
  const {
    pool,
    feed,
    symbol,
    timeframe,
    progressEveryPages = DEFAULT_PROGRESS_EVERY_PAGES,
    now = Date.now,
    log = (): void => undefined,
  } = options;

  const series = { exchange: options.exchange, symbol, timeframe };
  const targetTs = alignTs(options.from, timeframe);
  const upperTs = alignTs(options.to ?? now(), timeframe);

  const candles = createCandlesRepository(pool);
  const state = createIngestStateRepository(pool);

  const existing = await state.ensure({ ...series, targetTs });
  const coverage = await candles.getCoverage(series);

  const resumeFrom = existing.backfillCursorTs ?? coverage.fromTs;
  const startedFromTs = Math.min(resumeFrom ?? upperTs, upperTs);

  log({
    kind: 'start',
    symbol,
    timeframe,
    targetTs,
    cursorTs: startedFromTs,
    resumed: resumeFrom !== null,
  });

  const startedAt = now();

  let cursorTs = startedFromTs;
  let pages = 0;
  let fetched = 0;
  let upserted = 0;
  let stoppedBy: BackfillStop = 'target-reached';
  let done = cursorTs <= targetTs;

  while (cursorTs > targetTs) {
    if (options.maxPages !== undefined && pages >= options.maxPages) {
      stoppedBy = 'max-pages';
      break;
    }

    const page = await feed.getHistoryCandles({
      symbol,
      timeframe,
      endTime: cursorTs,
      limit: options.pageLimit,
    });

    pages += 1;

    if (page.length === 0) {
      stoppedBy = 'no-more-data';
      done = true;
      break;
    }

    fetched += page.length;
    const oldest = oldestOf(page);
    const keep = page.filter((candle) => candle.t >= targetTs && candle.t < cursorTs);
    const nextCursor = Math.max(targetTs, Math.min(oldest, cursorTs));

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const tx = {
        candles: createCandlesRepository(client),
        state: createIngestStateRepository(client),
      };
      if (keep.length > 0) {
        upserted += await tx.candles.upsertCandles({ ...series, source: 'rest', candles: keep });
      }
      await tx.state.setBackfillCursor({
        ...series,
        cursorTs: nextCursor,
        done: nextCursor <= targetTs,
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    if (nextCursor >= cursorTs) {
      stoppedBy = 'no-progress';
      break;
    }

    cursorTs = nextCursor;
    done = cursorTs <= targetTs;

    if (pages % progressEveryPages === 0) {
      const elapsedMs = Math.max(1, now() - startedAt);
      const candlesPerSecond = (fetched * 1000) / elapsedMs;
      const remaining = expectedCandleCount(targetTs, cursorTs, timeframe);
      log({
        kind: 'progress',
        pages,
        fetched,
        upserted,
        cursorTs,
        candlesPerSecond,
        remaining,
        etaMs: candlesPerSecond > 0 ? Math.round((remaining / candlesPerSecond) * 1000) : null,
      });
    }
  }

  await state.setBackfillCursor({ ...series, cursorTs, done });

  const report: BackfillReport = {
    symbol,
    timeframe,
    targetTs,
    startedFromTs,
    reachedTs: cursorTs,
    pages,
    fetched,
    upserted,
    done,
    stoppedBy,
    elapsedMs: now() - startedAt,
  };

  log({ kind: 'finish', report });

  return report;
}
