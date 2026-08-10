import type { Timeframe } from '@tt/shared';
import { env } from '../../config/env.js';
import type { Queryable, SeriesRef } from './candles.repo.js';

export interface IngestState {
  exchange: string;
  symbol: string;
  timeframe: Timeframe;
  backfillCursorTs: number | null;
  backfillTargetTs: number;
  backfillDone: boolean;
  lastCandleTs: number | null;
}

export interface EnsureStateInput extends SeriesRef {
  targetTs: number;
}

export interface SetCursorInput extends SeriesRef {
  cursorTs: number | null;
  done: boolean;
}

export interface IngestStateRepository {
  ensure(input: EnsureStateInput): Promise<IngestState>;
  get(series: SeriesRef): Promise<IngestState | null>;
  setBackfillCursor(input: SetCursorInput): Promise<void>;
}

interface StateRow {
  exchange: string;
  symbol: string;
  timeframe: Timeframe;
  backfill_cursor_ts: Date | null;
  backfill_target_ts: Date;
  backfill_done: boolean;
  last_candle_ts: Date | null;
}

const ENSURE_SQL = `
  INSERT INTO ingest_state (exchange, symbol, timeframe, backfill_target_ts)
  VALUES ($1, $2, $3, $4)
  ON CONFLICT (exchange, symbol, timeframe) DO UPDATE SET
    backfill_target_ts = EXCLUDED.backfill_target_ts,
    backfill_done = CASE
      WHEN EXCLUDED.backfill_target_ts < ingest_state.backfill_target_ts THEN false
      ELSE ingest_state.backfill_done
    END,
    updated_at = now()
  RETURNING exchange, symbol, timeframe, backfill_cursor_ts, backfill_target_ts,
            backfill_done, last_candle_ts
`;

const GET_SQL = `
  SELECT exchange, symbol, timeframe, backfill_cursor_ts, backfill_target_ts,
         backfill_done, last_candle_ts
  FROM ingest_state
  WHERE exchange = $1 AND symbol = $2 AND timeframe = $3
`;

const SET_CURSOR_SQL = `
  UPDATE ingest_state
  SET backfill_cursor_ts = $4, backfill_done = $5, updated_at = now()
  WHERE exchange = $1 AND symbol = $2 AND timeframe = $3
`;

function exchangeOf(series: SeriesRef): string {
  return series.exchange ?? env.EXCHANGE;
}

function toState(row: StateRow): IngestState {
  return {
    exchange: row.exchange,
    symbol: row.symbol,
    timeframe: row.timeframe,
    backfillCursorTs: row.backfill_cursor_ts?.getTime() ?? null,
    backfillTargetTs: row.backfill_target_ts.getTime(),
    backfillDone: row.backfill_done,
    lastCandleTs: row.last_candle_ts?.getTime() ?? null,
  };
}

export function createIngestStateRepository(db: Queryable): IngestStateRepository {
  return {
    async ensure(input: EnsureStateInput): Promise<IngestState> {
      const { rows } = await db.query<StateRow>(ENSURE_SQL, [
        exchangeOf(input),
        input.symbol,
        input.timeframe,
        new Date(input.targetTs),
      ]);

      const row = rows[0];
      if (row === undefined) {
        throw new Error(
          `No se pudo crear ingest_state para ${input.symbol} ${input.timeframe}: el upsert no devolvio fila.`,
        );
      }
      return toState(row);
    },

    async get(series: SeriesRef): Promise<IngestState | null> {
      const { rows } = await db.query<StateRow>(GET_SQL, [
        exchangeOf(series),
        series.symbol,
        series.timeframe,
      ]);

      const row = rows[0];
      return row === undefined ? null : toState(row);
    },

    async setBackfillCursor(input: SetCursorInput): Promise<void> {
      await db.query(SET_CURSOR_SQL, [
        exchangeOf(input),
        input.symbol,
        input.timeframe,
        input.cursorTs === null ? null : new Date(input.cursorTs),
        input.done,
      ]);
    },
  };
}
