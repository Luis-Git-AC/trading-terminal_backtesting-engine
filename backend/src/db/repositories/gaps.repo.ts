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

export interface GapsRepository {
  recordGap(input: RecordGapInput): Promise<GapRecord>;
  listOpen(series: SeriesRef): Promise<GapRecord[]>;
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
  };
}
