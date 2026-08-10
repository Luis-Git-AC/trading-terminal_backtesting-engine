import type { QueryResult, QueryResultRow } from 'pg';
import {
  expectedCandleCount,
  timeframeToMs,
  type Candle,
  type CandleSource,
  type Timeframe,
} from '@tt/shared';
import { env } from '../../config/env.js';

export const MAX_CANDLES_LIMIT = 5000;
export const UPSERT_BATCH_SIZE = 1000;

const INTERVAL_BY_TIMEFRAME = {
  '1m': '1 minute',
  '15m': '15 minutes',
  '1h': '1 hour',
} as const satisfies Record<Timeframe, string>;

export interface Queryable {
  query<R extends QueryResultRow>(text: string, values?: readonly unknown[]): Promise<QueryResult<R>>;
}

export interface SeriesRef {
  exchange?: string | undefined;
  symbol: string;
  timeframe: Timeframe;
}

export interface UpsertCandlesInput extends SeriesRef {
  source: CandleSource;
  candles: readonly Candle[];
}

export interface GetCandlesQuery extends SeriesRef {
  from: number;
  to: number;
  limit?: number;
}

export interface FindGapsQuery extends SeriesRef {
  from: number;
  to: number;
}

export interface Coverage {
  fromTs: number | null;
  toTs: number | null;
  rows: number;
}

export interface Gap {
  fromTs: number;
  toTs: number;
  missing: number;
}

export interface DuplicateKey {
  ts: number;
  count: number;
}

export interface CandlesRepository {
  upsertCandles(input: UpsertCandlesInput): Promise<number>;
  getCandles(query: GetCandlesQuery): Promise<Candle[]>;
  getCoverage(series: SeriesRef): Promise<Coverage>;
  findGaps(query: FindGapsQuery): Promise<Gap[]>;
  findDuplicates(query: FindGapsQuery): Promise<DuplicateKey[]>;
  getLastCandleTs(series: SeriesRef): Promise<number | null>;
}

interface CandleRowResult extends QueryResultRow {
  ts: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

const UPSERT_SQL = `
  INSERT INTO candles (exchange, symbol, timeframe, ts, open, high, low, close, volume, source, ingested_at)
  SELECT $1, $2, $3, page.ts, page.open, page.high, page.low, page.close, page.volume, $4, now()
  FROM unnest($5::timestamptz[], $6::numeric[], $7::numeric[], $8::numeric[], $9::numeric[], $10::numeric[])
       AS page(ts, open, high, low, close, volume)
  ON CONFLICT (exchange, symbol, timeframe, ts) DO UPDATE SET
    open        = EXCLUDED.open,
    high        = EXCLUDED.high,
    low         = EXCLUDED.low,
    close       = EXCLUDED.close,
    volume      = EXCLUDED.volume,
    source      = EXCLUDED.source,
    ingested_at = EXCLUDED.ingested_at
`;

const SELECT_RANGE_SQL = `
  SELECT ts, open, high, low, close, volume
  FROM candles
  WHERE exchange = $1 AND symbol = $2 AND timeframe = $3 AND ts >= $4 AND ts < $5
  ORDER BY ts ASC
  LIMIT $6
`;

const COVERAGE_SQL = `
  SELECT min(ts) AS from_ts, max(ts) AS to_ts, count(*)::text AS rows
  FROM candles
  WHERE exchange = $1 AND symbol = $2 AND timeframe = $3
`;

const GAPS_SQL = `
  SELECT prev_ts + $4::interval AS gap_from, ts - $4::interval AS gap_to
  FROM (
    SELECT ts, lag(ts) OVER (ORDER BY ts) AS prev_ts
    FROM candles
    WHERE exchange = $1 AND symbol = $2 AND timeframe = $3 AND ts >= $5 AND ts < $6
  ) series
  WHERE prev_ts IS NOT NULL AND ts - prev_ts > $4::interval
  ORDER BY gap_from ASC
`;

const DUPLICATES_SQL = `
  SELECT ts, count(*)::text AS count
  FROM candles
  WHERE exchange = $1 AND symbol = $2 AND timeframe = $3 AND ts >= $4 AND ts < $5
  GROUP BY ts
  HAVING count(*) > 1
  ORDER BY ts ASC
`;

const LAST_TS_SQL = `
  SELECT max(ts) AS ts FROM candles WHERE exchange = $1 AND symbol = $2 AND timeframe = $3
`;

function exchangeOf(series: SeriesRef): string {
  return series.exchange ?? env.EXCHANGE;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return MAX_CANDLES_LIMIT;
  if (!Number.isFinite(limit)) return MAX_CANDLES_LIMIT;
  return Math.min(MAX_CANDLES_LIMIT, Math.max(1, Math.floor(limit)));
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
}

function toCandle(row: CandleRowResult): Candle {
  return {
    t: row.ts.getTime(),
    o: Number(row.open),
    h: Number(row.high),
    l: Number(row.low),
    c: Number(row.close),
    v: Number(row.volume),
  };
}

export function createCandlesRepository(db: Queryable): CandlesRepository {
  return {
    async upsertCandles({ source, candles, ...series }: UpsertCandlesInput): Promise<number> {
      if (candles.length === 0) return 0;

      const exchange = exchangeOf(series);
      let affected = 0;

      for (const batch of chunk(candles, UPSERT_BATCH_SIZE)) {
        const result = await db.query(UPSERT_SQL, [
          exchange,
          series.symbol,
          series.timeframe,
          source,
          batch.map((candle) => new Date(candle.t)),
          batch.map((candle) => String(candle.o)),
          batch.map((candle) => String(candle.h)),
          batch.map((candle) => String(candle.l)),
          batch.map((candle) => String(candle.c)),
          batch.map((candle) => String(candle.v)),
        ]);
        affected += result.rowCount ?? 0;
      }

      return affected;
    },

    async getCandles(query: GetCandlesQuery): Promise<Candle[]> {
      const { rows } = await db.query<CandleRowResult>(SELECT_RANGE_SQL, [
        exchangeOf(query),
        query.symbol,
        query.timeframe,
        new Date(query.from),
        new Date(query.to),
        clampLimit(query.limit),
      ]);

      return rows.map(toCandle);
    },

    async getCoverage(series: SeriesRef): Promise<Coverage> {
      const { rows } = await db.query<{ from_ts: Date | null; to_ts: Date | null; rows: string }>(
        COVERAGE_SQL,
        [exchangeOf(series), series.symbol, series.timeframe],
      );

      const row = rows[0];
      return {
        fromTs: row?.from_ts?.getTime() ?? null,
        toTs: row?.to_ts?.getTime() ?? null,
        rows: Number(row?.rows ?? 0),
      };
    },

    async findGaps(query: FindGapsQuery): Promise<Gap[]> {
      const { rows } = await db.query<{ gap_from: Date; gap_to: Date }>(GAPS_SQL, [
        exchangeOf(query),
        query.symbol,
        query.timeframe,
        INTERVAL_BY_TIMEFRAME[query.timeframe],
        new Date(query.from),
        new Date(query.to),
      ]);

      const step = timeframeToMs(query.timeframe);

      return rows.map((row) => {
        const fromTs = row.gap_from.getTime();
        const toTs = row.gap_to.getTime();
        return { fromTs, toTs, missing: expectedCandleCount(fromTs, toTs + step, query.timeframe) };
      });
    },

    async findDuplicates(query: FindGapsQuery): Promise<DuplicateKey[]> {
      const { rows } = await db.query<{ ts: Date; count: string }>(DUPLICATES_SQL, [
        exchangeOf(query),
        query.symbol,
        query.timeframe,
        new Date(query.from),
        new Date(query.to),
      ]);

      return rows.map((row) => ({ ts: row.ts.getTime(), count: Number(row.count) }));
    },

    async getLastCandleTs(series: SeriesRef): Promise<number | null> {
      const { rows } = await db.query<{ ts: Date | null }>(LAST_TS_SQL, [
        exchangeOf(series),
        series.symbol,
        series.timeframe,
      ]);

      return rows[0]?.ts?.getTime() ?? null;
    },
  };
}
