import type { Timeframe } from '@tt/shared';
import { env } from '../../config/env.js';
import type { Queryable, SeriesRef } from './candles.repo.js';

export interface GapRecord {
  id: string;
  exchange: string;
  symbol: string;
  timeframe: Timeframe;
  fromTs: number;
  toTs: number;
  detectedAt: number;
  filledAt: number | null;
  attempts: number;
  lastError: string | null;
}

export interface RecordGapInput extends SeriesRef {
  fromTs: number;
  toTs: number;
}

export const NO_DATA_UPSTREAM = 'no-data-upstream';

export interface ListFillableQuery {
  exchange?: string | undefined;
  symbol?: string | undefined;
  timeframe?: Timeframe | undefined;
  maxAttempts: number;
  limit?: number;
}

export interface MarkFilledInput {
  id: string;
  lastError: string | null;
}

export interface GapsRepository {
  recordGap(input: RecordGapInput): Promise<GapRecord>;
  listOpen(series: SeriesRef): Promise<GapRecord[]>;
  listFillable(query: ListFillableQuery): Promise<GapRecord[]>;
  listNoDataFrom(series: SeriesRef): Promise<number[]>;
  registerAttempt(id: string): Promise<number>;
  markFilled(input: MarkFilledInput): Promise<void>;
  markError(input: MarkFilledInput): Promise<void>;
}

interface GapRow {
  id: string;
  exchange: string;
  symbol: string;
  timeframe: Timeframe;
  gap_from: Date;
  gap_to: Date;
  detected_at: Date;
  filled_at: Date | null;
  attempts: number;
  last_error: string | null;
}

const RETURNING = `
  id::text, exchange, symbol, timeframe, gap_from, gap_to, detected_at, filled_at, attempts, last_error
`;

const RECORD_SQL = `
  INSERT INTO ingest_gaps (exchange, symbol, timeframe, gap_from, gap_to)
  VALUES ($1, $2, $3, $4, $5)
  ON CONFLICT (exchange, symbol, timeframe, gap_from) WHERE filled_at IS NULL
  DO UPDATE SET gap_to = greatest(ingest_gaps.gap_to, EXCLUDED.gap_to)
  RETURNING ${RETURNING}
`;

const LIST_OPEN_SQL = `
  SELECT ${RETURNING}
  FROM ingest_gaps
  WHERE exchange = $1 AND symbol = $2 AND timeframe = $3 AND filled_at IS NULL
  ORDER BY gap_from ASC
`;

const LIST_FILLABLE_SQL = `
  SELECT ${RETURNING}
  FROM ingest_gaps
  WHERE filled_at IS NULL
    AND attempts < $1
    AND ($2::text IS NULL OR exchange = $2)
    AND ($3::text IS NULL OR symbol = $3)
    AND ($4::text IS NULL OR timeframe = $4)
  ORDER BY gap_from ASC
  LIMIT $5
`;

const LIST_NO_DATA_SQL = `
  SELECT gap_from
  FROM ingest_gaps
  WHERE exchange = $1 AND symbol = $2 AND timeframe = $3
    AND filled_at IS NOT NULL AND last_error = '${NO_DATA_UPSTREAM}'
`;

const REGISTER_ATTEMPT_SQL = `
  UPDATE ingest_gaps SET attempts = attempts + 1 WHERE id = $1::bigint RETURNING attempts
`;

const MARK_FILLED_SQL = `
  UPDATE ingest_gaps SET filled_at = now(), last_error = $2 WHERE id = $1::bigint
`;

const MARK_ERROR_SQL = `
  UPDATE ingest_gaps SET last_error = $2 WHERE id = $1::bigint
`;

function exchangeOf(series: SeriesRef): string {
  return series.exchange ?? env.EXCHANGE;
}

function toGap(row: GapRow): GapRecord {
  return {
    id: row.id,
    exchange: row.exchange,
    symbol: row.symbol,
    timeframe: row.timeframe,
    fromTs: row.gap_from.getTime(),
    toTs: row.gap_to.getTime(),
    detectedAt: row.detected_at.getTime(),
    filledAt: row.filled_at?.getTime() ?? null,
    attempts: row.attempts,
    lastError: row.last_error,
  };
}

export function createGapsRepository(db: Queryable): GapsRepository {
  return {
    async recordGap(input: RecordGapInput): Promise<GapRecord> {
      if (input.toTs < input.fromTs) {
        throw new RangeError(
          `Rango de hueco invertido para ${input.symbol} ${input.timeframe}: ${input.fromTs} > ${input.toTs}`,
        );
      }

      const { rows } = await db.query<GapRow>(RECORD_SQL, [
        exchangeOf(input),
        input.symbol,
        input.timeframe,
        new Date(input.fromTs),
        new Date(input.toTs),
      ]);

      const row = rows[0];
      if (row === undefined) {
        throw new Error(
          `No se pudo registrar el hueco de ${input.symbol} ${input.timeframe}: el upsert no devolvio fila.`,
        );
      }
      return toGap(row);
    },

    async listOpen(series: SeriesRef): Promise<GapRecord[]> {
      const { rows } = await db.query<GapRow>(LIST_OPEN_SQL, [
        exchangeOf(series),
        series.symbol,
        series.timeframe,
      ]);
      return rows.map(toGap);
    },

    async listFillable(query: ListFillableQuery): Promise<GapRecord[]> {
      const { rows } = await db.query<GapRow>(LIST_FILLABLE_SQL, [
        query.maxAttempts,
        query.exchange ?? null,
        query.symbol ?? null,
        query.timeframe ?? null,
        query.limit ?? 100,
      ]);
      return rows.map(toGap);
    },

    async listNoDataFrom(series: SeriesRef): Promise<number[]> {
      const { rows } = await db.query<{ gap_from: Date }>(LIST_NO_DATA_SQL, [
        exchangeOf(series),
        series.symbol,
        series.timeframe,
      ]);
      return rows.map((row) => row.gap_from.getTime());
    },

    async registerAttempt(id: string): Promise<number> {
      const { rows } = await db.query<{ attempts: number }>(REGISTER_ATTEMPT_SQL, [id]);
      const row = rows[0];
      if (row === undefined) throw new Error(`No existe el hueco ${id}`);
      return row.attempts;
    },

    async markFilled(input: MarkFilledInput): Promise<void> {
      await db.query(MARK_FILLED_SQL, [input.id, input.lastError]);
    },

    async markError(input: MarkFilledInput): Promise<void> {
      await db.query(MARK_ERROR_SQL, [input.id, input.lastError]);
    },
  };
}
