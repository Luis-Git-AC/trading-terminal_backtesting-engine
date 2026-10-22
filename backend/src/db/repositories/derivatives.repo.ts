import type { CandleSource } from '@tt/shared';
import { defaultExchange, env } from '../../config/env.js';
import type { Queryable } from './candles.repo.js';

export const MAX_DERIVATIVES_LIMIT = 5000;
export const UPSERT_BATCH_SIZE = 1000;

export interface MarketRef {
  exchange?: string | undefined;
  symbol: string;
}

export interface RangeQuery extends MarketRef {
  from: number;
  to: number;
  limit?: number;
}

export interface FundingRate {
  t: number;
  rate: number;
  intervalHours: number;
}

export interface OpenInterestPoint {
  t: number;
  base: number;
  quote: number | null;
}

export interface UpsertFundingInput extends MarketRef {
  source: CandleSource;
  rates: readonly FundingRate[];
}

export interface UpsertOpenInterestInput extends MarketRef {
  source: CandleSource;
  points: readonly OpenInterestPoint[];
}

export interface DerivativesRepository {
  upsertFundingRates(input: UpsertFundingInput): Promise<number>;
  getFundingRates(query: RangeQuery): Promise<FundingRate[]>;
  getLastFundingTs(market: MarketRef): Promise<number | null>;
  upsertOpenInterest(input: UpsertOpenInterestInput): Promise<number>;
  getOpenInterest(query: RangeQuery): Promise<OpenInterestPoint[]>;
  getLastOpenInterestTs(market: MarketRef): Promise<number | null>;
}

const UPSERT_FUNDING_SQL = `
  INSERT INTO funding_rates (exchange, symbol, ts, rate, interval_hours, source, ingested_at)
  SELECT $1, $2, page.ts, page.rate, page.interval_hours, $3, now()
  FROM unnest($4::timestamptz[], $5::numeric[], $6::integer[]) AS page(ts, rate, interval_hours)
  ON CONFLICT (exchange, symbol, ts) DO UPDATE SET
    rate           = EXCLUDED.rate,
    interval_hours = EXCLUDED.interval_hours,
    source         = EXCLUDED.source,
    ingested_at    = EXCLUDED.ingested_at
  WHERE funding_rates.rate           IS DISTINCT FROM EXCLUDED.rate
     OR funding_rates.interval_hours IS DISTINCT FROM EXCLUDED.interval_hours
`;

const SELECT_FUNDING_SQL = `
  SELECT ts, rate, interval_hours
  FROM funding_rates
  WHERE exchange = $1 AND symbol = $2 AND ts >= $3 AND ts < $4
  ORDER BY ts ASC
  LIMIT $5
`;

const LAST_FUNDING_TS_SQL = `
  SELECT max(ts) AS ts FROM funding_rates WHERE exchange = $1 AND symbol = $2
`;

const UPSERT_OI_SQL = `
  INSERT INTO open_interest (exchange, symbol, ts, oi_base, oi_quote, source, ingested_at)
  SELECT $1, $2, page.ts, page.oi_base, page.oi_quote, $3, now()
  FROM unnest($4::timestamptz[], $5::numeric[], $6::numeric[]) AS page(ts, oi_base, oi_quote)
  ON CONFLICT (exchange, symbol, ts) DO UPDATE SET
    oi_base     = EXCLUDED.oi_base,
    oi_quote    = EXCLUDED.oi_quote,
    source      = EXCLUDED.source,
    ingested_at = EXCLUDED.ingested_at
  WHERE open_interest.oi_base  IS DISTINCT FROM EXCLUDED.oi_base
     OR open_interest.oi_quote IS DISTINCT FROM EXCLUDED.oi_quote
`;

const SELECT_OI_SQL = `
  SELECT ts, oi_base, oi_quote
  FROM open_interest
  WHERE exchange = $1 AND symbol = $2 AND ts >= $3 AND ts < $4
  ORDER BY ts ASC
  LIMIT $5
`;

const LAST_OI_TS_SQL = `
  SELECT max(ts) AS ts FROM open_interest WHERE exchange = $1 AND symbol = $2
`;

function exchangeOf(market: MarketRef): string {
  return market.exchange ?? defaultExchange(env);
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return MAX_DERIVATIVES_LIMIT;
  return Math.min(MAX_DERIVATIVES_LIMIT, Math.max(1, Math.floor(limit)));
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
}

export function createDerivativesRepository(db: Queryable): DerivativesRepository {
  return {
    async upsertFundingRates({ source, rates, ...market }: UpsertFundingInput): Promise<number> {
      if (rates.length === 0) return 0;

      const exchange = exchangeOf(market);
      let affected = 0;

      for (const batch of chunk(rates, UPSERT_BATCH_SIZE)) {
        const result = await db.query(UPSERT_FUNDING_SQL, [
          exchange,
          market.symbol,
          source,
          batch.map((rate) => new Date(rate.t)),
          batch.map((rate) => String(rate.rate)),
          batch.map((rate) => rate.intervalHours),
        ]);
        affected += result.rowCount ?? 0;
      }

      return affected;
    },

    async getFundingRates(query: RangeQuery): Promise<FundingRate[]> {
      const { rows } = await db.query<{ ts: Date; rate: string; interval_hours: number }>(
        SELECT_FUNDING_SQL,
        [
          exchangeOf(query),
          query.symbol,
          new Date(query.from),
          new Date(query.to),
          clampLimit(query.limit),
        ],
      );

      return rows.map((row) => ({
        t: row.ts.getTime(),
        rate: Number(row.rate),
        intervalHours: row.interval_hours,
      }));
    },

    async getLastFundingTs(market: MarketRef): Promise<number | null> {
      const { rows } = await db.query<{ ts: Date | null }>(LAST_FUNDING_TS_SQL, [
        exchangeOf(market),
        market.symbol,
      ]);

      return rows[0]?.ts?.getTime() ?? null;
    },

    async upsertOpenInterest({
      source,
      points,
      ...market
    }: UpsertOpenInterestInput): Promise<number> {
      if (points.length === 0) return 0;

      const exchange = exchangeOf(market);
      let affected = 0;

      for (const batch of chunk(points, UPSERT_BATCH_SIZE)) {
        const result = await db.query(UPSERT_OI_SQL, [
          exchange,
          market.symbol,
          source,
          batch.map((point) => new Date(point.t)),
          batch.map((point) => String(point.base)),
          batch.map((point) => (point.quote === null ? null : String(point.quote))),
        ]);
        affected += result.rowCount ?? 0;
      }

      return affected;
    },

    async getOpenInterest(query: RangeQuery): Promise<OpenInterestPoint[]> {
      const { rows } = await db.query<{ ts: Date; oi_base: string; oi_quote: string | null }>(
        SELECT_OI_SQL,
        [
          exchangeOf(query),
          query.symbol,
          new Date(query.from),
          new Date(query.to),
          clampLimit(query.limit),
        ],
      );

      return rows.map((row) => ({
        t: row.ts.getTime(),
        base: Number(row.oi_base),
        quote: row.oi_quote === null ? null : Number(row.oi_quote),
      }));
    },

    async getLastOpenInterestTs(market: MarketRef): Promise<number | null> {
      const { rows } = await db.query<{ ts: Date | null }>(LAST_OI_TS_SQL, [
        exchangeOf(market),
        market.symbol,
      ]);

      return rows[0]?.ts?.getTime() ?? null;
    },
  };
}
