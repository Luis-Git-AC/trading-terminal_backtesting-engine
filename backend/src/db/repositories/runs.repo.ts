import type { RunStatus, Timeframe } from '@tt/shared';
import type { PoolClient } from 'pg';
import type { BacktestMetrics, EquityPoint, ExecConfig, Trade } from '../../engine/types.js';
import { serializeCanonical, sha256 } from '../../engine/serialize.js';
import type { Queryable } from './candles.repo.js';

export interface RunParamsHashInput {
  readonly exchange: string;
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly strategyId: string;
  readonly params: Record<string, unknown>;
  readonly exec: ExecConfig;
  readonly seed: number;
  readonly rangeFrom: number;
  readonly rangeTo: number;
  readonly engineVersion: string;
}

export interface CreateRunInput extends RunParamsHashInput {
  readonly label?: string | undefined;
  readonly barsTotal?: number | undefined;
}

export interface RunRecord extends RunParamsHashInput {
  readonly id: string;
  readonly status: RunStatus;
  readonly paramsHash: string;
  readonly label: string | null;
  readonly metrics: BacktestMetrics | null;
  readonly barsTotal: number | null;
  readonly barsDone: number;
  readonly error: string | null;
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
}

export interface CompleteRunInput {
  readonly runId: string;
  readonly metrics: BacktestMetrics;
  readonly trades: readonly Trade[];
  readonly equity: readonly EquityPoint[];
}

export interface ListRunsQuery {
  readonly status?: RunStatus | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

export interface TradesPage {
  readonly trades: readonly Trade[];
  readonly nextCursor: number | null;
}

export interface RunsRepository {
  createRun(input: CreateRunInput): Promise<RunRecord>;
  getRun(runId: string): Promise<RunRecord | null>;
  listRuns(query?: ListRunsQuery): Promise<readonly RunRecord[]>;
  markRunning(runId: string, barsTotal: number): Promise<boolean>;
  requeueRun(runId: string): Promise<boolean>;
  updateProgress(runId: string, barsDone: number): Promise<void>;
  completeRun(input: CompleteRunInput): Promise<void>;
  failRun(runId: string, error: string): Promise<void>;
  cancelRun(runId: string): Promise<boolean>;
  deleteRun(runId: string): Promise<boolean>;
  getTrades(runId: string, limit?: number, cursor?: number): Promise<TradesPage>;
  getEquity(runId: string): Promise<readonly EquityPoint[]>;
}

export const DEFAULT_LIST_LIMIT = 50;

export const DEFAULT_TRADES_LIMIT = 500;

export function paramsHash(input: RunParamsHashInput): string {
  return sha256(
    serializeCanonical({
      engineVersion: input.engineVersion,
      exchange: input.exchange,
      exec: input.exec,
      params: input.params,
      range: { from: input.rangeFrom, to: input.rangeTo },
      seed: input.seed,
      strategyId: input.strategyId,
      symbol: input.symbol,
      timeframe: input.timeframe,
    }),
  );
}

interface RunRow {
  id: string;
  status: RunStatus;
  exchange: string;
  symbol: string;
  timeframe: Timeframe;
  strategy_id: string;
  params: Record<string, unknown>;
  exec_config: ExecConfig;
  seed: string;
  range_from: Date;
  range_to: Date;
  engine_version: string;
  params_hash: string;
  label: string | null;
  metrics: BacktestMetrics | null;
  bars_total: number | null;
  bars_done: number;
  error: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

interface TradeRow {
  seq: number;
  side: 'long' | 'short';
  entry_ts: Date;
  entry_price: string;
  exit_ts: Date;
  exit_price: string;
  qty: string;
  fees: string;
  pnl_quote: string;
  pnl_r: string;
  exit_reason: Trade['exitReason'];
  mae_r: string | null;
  mfe_r: string | null;
}

interface EquityRow {
  ts: Date;
  equity: string;
  drawdown: string;
}

function toRunRecord(row: RunRow): RunRecord {
  return {
    id: row.id,
    status: row.status,
    exchange: row.exchange,
    symbol: row.symbol,
    timeframe: row.timeframe,
    strategyId: row.strategy_id,
    params: row.params,
    exec: row.exec_config,
    seed: Number(row.seed),
    rangeFrom: row.range_from.getTime(),
    rangeTo: row.range_to.getTime(),
    engineVersion: row.engine_version,
    paramsHash: row.params_hash,
    label: row.label,
    metrics: row.metrics,
    barsTotal: row.bars_total,
    barsDone: row.bars_done,
    error: row.error,
    createdAt: row.created_at.getTime(),
    startedAt: row.started_at?.getTime() ?? null,
    finishedAt: row.finished_at?.getTime() ?? null,
  };
}

function toTrade(row: TradeRow): Trade {
  return {
    seq: row.seq,
    side: row.side,
    entryTs: row.entry_ts.getTime(),
    entryPrice: Number(row.entry_price),
    exitTs: row.exit_ts.getTime(),
    exitPrice: Number(row.exit_price),
    qty: Number(row.qty),
    fees: Number(row.fees),
    pnlQuote: Number(row.pnl_quote),
    pnlR: Number(row.pnl_r),
    exitReason: row.exit_reason,
    maeR: Number(row.mae_r ?? 0),
    mfeR: Number(row.mfe_r ?? 0),
  };
}

const RUN_COLUMNS = `
  id, status, exchange, symbol, timeframe, strategy_id, params, exec_config, seed,
  range_from, range_to, engine_version, params_hash, label, metrics,
  bars_total, bars_done, error, created_at, started_at, finished_at
`;

export function createRunsRepository(db: Queryable): RunsRepository {
  return {
    async createRun(input: CreateRunInput): Promise<RunRecord> {
      const { rows } = await db.query<RunRow>(
        `INSERT INTO backtest_runs (
           exchange, symbol, timeframe, strategy_id, params, exec_config, seed,
           range_from, range_to, engine_version, params_hash, label, bars_total
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,to_timestamp($8/1000.0),to_timestamp($9/1000.0),$10,$11,$12,$13)
         RETURNING ${RUN_COLUMNS}`,
        [
          input.exchange,
          input.symbol,
          input.timeframe,
          input.strategyId,
          JSON.stringify(input.params),
          JSON.stringify(input.exec),
          input.seed,
          input.rangeFrom,
          input.rangeTo,
          input.engineVersion,
          paramsHash(input),
          input.label ?? null,
          input.barsTotal ?? null,
        ],
      );
      const row = rows[0];
      if (row === undefined) {
        throw new Error('INSERT de backtest_runs no devolvio fila');
      }
      return toRunRecord(row);
    },

    async getRun(runId: string): Promise<RunRecord | null> {
      const { rows } = await db.query<RunRow>(
        `SELECT ${RUN_COLUMNS} FROM backtest_runs WHERE id = $1`,
        [runId],
      );
      const row = rows[0];
      return row === undefined ? null : toRunRecord(row);
    },

    async listRuns(query: ListRunsQuery = {}): Promise<readonly RunRecord[]> {
      const { rows } = await db.query<RunRow>(
        `SELECT ${RUN_COLUMNS} FROM backtest_runs
         WHERE ($1::text IS NULL OR status = $1)
         ORDER BY created_at DESC, id DESC
         LIMIT $2 OFFSET $3`,
        [query.status ?? null, query.limit ?? DEFAULT_LIST_LIMIT, query.offset ?? 0],
      );
      return rows.map(toRunRecord);
    },

    async markRunning(runId: string, barsTotal: number): Promise<boolean> {
      const { rowCount } = await db.query(
        `UPDATE backtest_runs
         SET status = 'running', started_at = now(), bars_total = $2, bars_done = 0
         WHERE id = $1 AND status = 'queued'`,
        [runId, barsTotal],
      );
      return (rowCount ?? 0) > 0;
    },

    async requeueRun(runId: string): Promise<boolean> {
      const { rowCount } = await db.query(
        `UPDATE backtest_runs
         SET status = 'queued', started_at = NULL, bars_done = 0, error = NULL
         WHERE id = $1 AND status = 'running'`,
        [runId],
      );
      return (rowCount ?? 0) > 0;
    },

    async updateProgress(runId: string, barsDone: number): Promise<void> {
      await db.query(
        `UPDATE backtest_runs SET bars_done = greatest(bars_done, $2)
         WHERE id = $1 AND status = 'running'`,
        [runId, barsDone],
      );
    },

    async completeRun(input: CompleteRunInput): Promise<void> {
      const client: TxClient = await requireClient(db);
      try {
        await client.query('BEGIN');

        const { rowCount } = await client.query(
          `UPDATE backtest_runs
           SET status = 'completed', metrics = $2, finished_at = now(),
               bars_done = coalesce(bars_total, bars_done), error = NULL
           WHERE id = $1 AND status IN ('running', 'queued')`,
          [input.runId, JSON.stringify(input.metrics)],
        );

        if ((rowCount ?? 0) === 0) {
          throw new Error(`El run ${input.runId} no estaba en curso, no se puede completar`);
        }

        await client.query('DELETE FROM backtest_trades WHERE run_id = $1', [input.runId]);
        await client.query('DELETE FROM backtest_equity WHERE run_id = $1', [input.runId]);

        if (input.trades.length > 0) {
          await client.query(
            `INSERT INTO backtest_trades (
               run_id, seq, side, entry_ts, entry_price, exit_ts, exit_price,
               qty, fees, pnl_quote, pnl_r, exit_reason, mae_r, mfe_r
             )
             SELECT $1,
                    t.seq, t.side,
                    to_timestamp(t.entry_ts/1000.0), t.entry_price,
                    to_timestamp(t.exit_ts/1000.0), t.exit_price,
                    t.qty, t.fees, t.pnl_quote, t.pnl_r, t.exit_reason, t.mae_r, t.mfe_r
             FROM unnest(
               $2::int[], $3::text[], $4::bigint[], $5::numeric[], $6::bigint[], $7::numeric[],
               $8::numeric[], $9::numeric[], $10::numeric[], $11::numeric[], $12::text[],
               $13::numeric[], $14::numeric[]
             ) AS t(seq, side, entry_ts, entry_price, exit_ts, exit_price,
                    qty, fees, pnl_quote, pnl_r, exit_reason, mae_r, mfe_r)`,
            [
              input.runId,
              input.trades.map((trade) => trade.seq),
              input.trades.map((trade) => trade.side),
              input.trades.map((trade) => trade.entryTs),
              input.trades.map((trade) => String(trade.entryPrice)),
              input.trades.map((trade) => trade.exitTs),
              input.trades.map((trade) => String(trade.exitPrice)),
              input.trades.map((trade) => String(trade.qty)),
              input.trades.map((trade) => String(trade.fees)),
              input.trades.map((trade) => String(trade.pnlQuote)),
              input.trades.map((trade) => String(trade.pnlR)),
              input.trades.map((trade) => trade.exitReason),
              input.trades.map((trade) => String(trade.maeR)),
              input.trades.map((trade) => String(trade.mfeR)),
            ],
          );
        }

        if (input.equity.length > 0) {
          await client.query(
            `INSERT INTO backtest_equity (run_id, ts, equity, drawdown)
             SELECT $1, to_timestamp(e.ts/1000.0), e.equity, e.drawdown
             FROM unnest($2::bigint[], $3::numeric[], $4::numeric[]) AS e(ts, equity, drawdown)
             ON CONFLICT (run_id, ts) DO UPDATE
               SET equity = excluded.equity, drawdown = excluded.drawdown`,
            [
              input.runId,
              input.equity.map((point) => point.t),
              input.equity.map((point) => String(point.equity)),
              input.equity.map((point) => String(point.drawdown)),
            ],
          );
        }

        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        releaseClient(client);
      }
    },

    async failRun(runId: string, error: string): Promise<void> {
      await db.query(
        `UPDATE backtest_runs SET status = 'failed', error = $2, finished_at = now()
         WHERE id = $1 AND status IN ('queued', 'running')`,
        [runId, error],
      );
    },

    async cancelRun(runId: string): Promise<boolean> {
      const { rowCount } = await db.query(
        `UPDATE backtest_runs SET status = 'cancelled', finished_at = now()
         WHERE id = $1 AND status IN ('queued', 'running')`,
        [runId],
      );
      return (rowCount ?? 0) > 0;
    },

    async deleteRun(runId: string): Promise<boolean> {
      const { rowCount } = await db.query('DELETE FROM backtest_runs WHERE id = $1', [runId]);
      return (rowCount ?? 0) > 0;
    },

    async getTrades(
      runId: string,
      limit = DEFAULT_TRADES_LIMIT,
      cursor = 0,
    ): Promise<TradesPage> {
      const { rows } = await db.query<TradeRow>(
        `SELECT seq, side, entry_ts, entry_price, exit_ts, exit_price, qty, fees,
                pnl_quote, pnl_r, exit_reason, mae_r, mfe_r
         FROM backtest_trades
         WHERE run_id = $1 AND seq > $2
         ORDER BY seq ASC
         LIMIT $3`,
        [runId, cursor, limit],
      );
      const trades = rows.map(toTrade);
      const last = trades[trades.length - 1];
      return {
        trades,
        nextCursor: trades.length === limit && last !== undefined ? last.seq : null,
      };
    },

    async getEquity(runId: string): Promise<readonly EquityPoint[]> {
      const { rows } = await db.query<EquityRow>(
        `SELECT ts, equity, drawdown FROM backtest_equity WHERE run_id = $1 ORDER BY ts ASC`,
        [runId],
      );
      return rows.map((row) => ({
        t: row.ts.getTime(),
        equity: Number(row.equity),
        drawdown: Number(row.drawdown),
      }));
    },
  };
}

interface TxClient extends Queryable {
  release?: () => void;
}

interface Connectable {
  connect(): Promise<PoolClient>;
}

function isConnectable(db: Queryable): db is Queryable & Connectable {
  return typeof (db as Partial<Connectable>).connect === 'function';
}

async function requireClient(db: Queryable): Promise<TxClient> {
  if (isConnectable(db)) {
    return await db.connect();
  }
  return db;
}

function releaseClient(client: TxClient): void {
  client.release?.();
}
