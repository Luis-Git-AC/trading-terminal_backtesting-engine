import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BacktestMetrics, EquityPoint, ExecConfig, Trade } from '../../engine/types.js';
import { runMigrations } from '../migrate.js';
import { createScratchDatabase, type ScratchDatabase } from '../../testing/scratch-db.js';
import {
  createRunsRepository,
  paramsHash,
  type CreateRunInput,
  type RunsRepository,
} from './runs.repo.js';

const EXEC: ExecConfig = {
  initialCapital: 10_000,
  riskPerTradePct: 1,
  feeBps: 6,
  slippageBps: 2,
  fillModel: 'next-open',
};

const RANGE_FROM = Date.UTC(2026, 0, 1);
const RANGE_TO = Date.UTC(2026, 5, 30);

function runInput(overrides: Partial<CreateRunInput> = {}): CreateRunInput {
  return {
    exchange: 'bitget',
    symbol: 'BTCUSDT',
    timeframe: '15m',
    strategyId: 'ema-cross',
    params: { fastPeriod: 12, slowPeriod: 26 },
    exec: EXEC,
    seed: 42,
    rangeFrom: RANGE_FROM,
    rangeTo: RANGE_TO,
    engineVersion: '1.0.0',
    ...overrides,
  };
}

const METRICS: BacktestMetrics = {
  netProfit: 1843.21,
  netProfitPct: 18.43,
  maxDrawdown: 0.121,
  maxDrawdownQuote: 1204.55,
  winRate: 0.42,
  profitFactor: 1.61,
  expectancyR: 0.23,
  trades: 2,
  wins: 1,
  losses: 1,
  avgWinR: 1.82,
  avgLossR: -0.98,
  largestWinR: 1.82,
  largestLossR: -0.98,
  exposurePct: 34.2,
  barsTotal: 100,
  openAtEnd: false,
};

function trade(seq: number, pnlQuote: number): Trade {
  return {
    seq,
    side: seq % 2 === 0 ? 'short' : 'long',
    entryTs: RANGE_FROM + seq * 900_000,
    entryPrice: 100 + seq,
    exitTs: RANGE_FROM + (seq + 1) * 900_000,
    exitPrice: 100 + seq + pnlQuote / 10,
    qty: 10,
    fees: 1.5,
    pnlQuote,
    pnlR: pnlQuote / 100,
    exitReason: 'signal',
    maeR: 0.2,
    mfeR: 1.1,
  };
}

const EQUITY: EquityPoint[] = [
  { t: RANGE_FROM, equity: 10_000, drawdown: 0 },
  { t: RANGE_FROM + 900_000, equity: 10_200, drawdown: 0 },
  { t: RANGE_FROM + 1_800_000, equity: 10_100, drawdown: 0.0098039216 },
];

describe('runs.repo', () => {
  let db: ScratchDatabase;
  let runs: RunsRepository;

  beforeAll(async () => {
    db = await createScratchDatabase({ applicationName: 'tt-itest-runs-repo' });
    await runMigrations({ pool: db.pool });
    runs = createRunsRepository(db.pool);
  });

  afterAll(async () => {
    await db.drop();
  });

  beforeEach(async () => {
    await db.pool.query('TRUNCATE backtest_runs CASCADE');
  });

  describe('paramsHash', () => {
    it('dos runs con el mismo input dan el mismo hash', () => {
      expect(paramsHash(runInput())).toBe(paramsHash(runInput()));
    });

    it('no depende del orden en que se construya el objeto de params', () => {
      const a = runInput({ params: { fastPeriod: 12, slowPeriod: 26 } });
      const b = runInput({ params: { slowPeriod: 26, fastPeriod: 12 } });
      expect(paramsHash(b)).toBe(paramsHash(a));
    });

    it('cambia si cambia cualquier pieza del input', () => {
      const base = paramsHash(runInput());
      expect(paramsHash(runInput({ seed: 43 }))).not.toBe(base);
      expect(paramsHash(runInput({ engineVersion: '1.0.1' }))).not.toBe(base);
      expect(paramsHash(runInput({ params: { fastPeriod: 13, slowPeriod: 26 } }))).not.toBe(base);
      expect(paramsHash(runInput({ exec: { ...EXEC, feeBps: 7 } }))).not.toBe(base);
      expect(paramsHash(runInput({ rangeTo: RANGE_TO + 1 }))).not.toBe(base);
    });
  });

  describe('createRun y getRun', () => {
    it('crea el run en queued y lo devuelve entero', async () => {
      const created = await runs.createRun(runInput({ label: 'ema 12/26' }));

      expect(created.status).toBe('queued');
      expect(created.barsDone).toBe(0);
      expect(created.label).toBe('ema 12/26');
      expect(created.paramsHash).toBe(paramsHash(runInput()));
      expect(created.rangeFrom).toBe(RANGE_FROM);
      expect(created.rangeTo).toBe(RANGE_TO);

      const fetched = await runs.getRun(created.id);
      expect(fetched).toEqual(created);
    });

    it('getRun de un id inexistente devuelve null', async () => {
      expect(await runs.getRun('00000000-0000-4000-8000-000000000000')).toBeNull();
    });
  });

  describe('listRuns', () => {
    it('ordena por created_at descendente y pagina', async () => {
      const first = await runs.createRun(runInput({ label: 'a' }));
      const second = await runs.createRun(runInput({ label: 'b' }));
      const third = await runs.createRun(runInput({ label: 'c' }));

      const page = await runs.listRuns({ limit: 2 });
      expect(page.map((run) => run.id)).toEqual([third.id, second.id]);

      const next = await runs.listRuns({ limit: 2, offset: 2 });
      expect(next.map((run) => run.id)).toEqual([first.id]);
    });

    it('filtra por estado', async () => {
      const queued = await runs.createRun(runInput());
      const running = await runs.createRun(runInput());
      await runs.markRunning(running.id, 100);

      expect((await runs.listRuns({ status: 'queued' })).map((run) => run.id)).toEqual([queued.id]);
      expect((await runs.listRuns({ status: 'running' })).map((run) => run.id)).toEqual([
        running.id,
      ]);
    });
  });

  describe('ciclo de vida', () => {
    it('markRunning solo aplica desde queued', async () => {
      const run = await runs.createRun(runInput());

      expect(await runs.markRunning(run.id, 100)).toBe(true);
      expect(await runs.markRunning(run.id, 100)).toBe(false);

      const after = await runs.getRun(run.id);
      expect(after?.status).toBe('running');
      expect(after?.barsTotal).toBe(100);
      expect(after?.startedAt).not.toBeNull();
    });

    it('updateProgress nunca hace retroceder barsDone', async () => {
      const run = await runs.createRun(runInput());
      await runs.markRunning(run.id, 100);

      await runs.updateProgress(run.id, 40);
      await runs.updateProgress(run.id, 10);

      expect((await runs.getRun(run.id))?.barsDone).toBe(40);
    });

    it('failRun deja el error y la marca de fin', async () => {
      const run = await runs.createRun(runInput());
      await runs.markRunning(run.id, 100);
      await runs.failRun(run.id, 'el motor exploto');

      const after = await runs.getRun(run.id);
      expect(after?.status).toBe('failed');
      expect(after?.error).toBe('el motor exploto');
      expect(after?.finishedAt).not.toBeNull();
    });

    it('cancelRun solo aplica sobre queued o running', async () => {
      const run = await runs.createRun(runInput());
      expect(await runs.cancelRun(run.id)).toBe(true);
      expect(await runs.cancelRun(run.id)).toBe(false);
      expect((await runs.getRun(run.id))?.status).toBe('cancelled');
    });
  });

  describe('completeRun', () => {
    it('el drawdown se guarda con la precision de numeric(12,6) de docs/02', async () => {
      const run = await runs.createRun(runInput());
      await runs.markRunning(run.id, 100);
      await runs.completeRun({
        runId: run.id,
        metrics: METRICS,
        trades: [],
        equity: [{ t: RANGE_FROM, equity: 10_000, drawdown: 0.12345678 }],
      });

      expect((await runs.getEquity(run.id))[0]?.drawdown).toBe(0.123457);
    });

    it('persiste metricas, trades y curva en una sola pasada', async () => {
      const run = await runs.createRun(runInput());
      await runs.markRunning(run.id, 100);

      await runs.completeRun({
        runId: run.id,
        metrics: METRICS,
        trades: [trade(1, 200), trade(2, -100)],
        equity: EQUITY,
      });

      const after = await runs.getRun(run.id);
      expect(after?.status).toBe('completed');
      expect(after?.metrics).toEqual(METRICS);
      expect(after?.finishedAt).not.toBeNull();

      const page = await runs.getTrades(run.id);
      expect(page.trades).toHaveLength(2);
      expect(page.trades[0]?.pnlQuote).toBe(200);
      expect(page.trades[1]?.side).toBe('short');

      const equity = await runs.getEquity(run.id);
      expect(equity.map((point) => ({ t: point.t, equity: point.equity }))).toEqual(
        EQUITY.map((point) => ({ t: point.t, equity: point.equity })),
      );
      expect(equity[2]?.drawdown).toBe(0.009804);
    });

    it('es atomico: si falla a mitad no deja trades sin el run completado', async () => {
      const run = await runs.createRun(runInput());
      await runs.markRunning(run.id, 100);

      const broken = [trade(1, 200), { ...trade(2, -100), exitReason: 'inventado' }] as Trade[];

      await expect(
        runs.completeRun({ runId: run.id, metrics: METRICS, trades: broken, equity: EQUITY }),
      ).rejects.toThrow();

      const after = await runs.getRun(run.id);
      expect(after?.status).toBe('running');
      expect(after?.metrics).toBeNull();
      expect((await runs.getTrades(run.id)).trades).toEqual([]);
      expect(await runs.getEquity(run.id)).toEqual([]);
    });

    it('no completa un run que ya no estaba en curso', async () => {
      const run = await runs.createRun(runInput());
      await runs.cancelRun(run.id);

      await expect(
        runs.completeRun({ runId: run.id, metrics: METRICS, trades: [], equity: [] }),
      ).rejects.toThrow(/no estaba en curso/);
    });
  });

  describe('getTrades', () => {
    it('pagina por cursor de seq', async () => {
      const run = await runs.createRun(runInput());
      await runs.markRunning(run.id, 100);
      await runs.completeRun({
        runId: run.id,
        metrics: METRICS,
        trades: Array.from({ length: 5 }, (_, index) => trade(index + 1, 10 * (index + 1))),
        equity: [],
      });

      const first = await runs.getTrades(run.id, 2);
      expect(first.trades.map((item) => item.seq)).toEqual([1, 2]);
      expect(first.nextCursor).toBe(2);

      const second = await runs.getTrades(run.id, 2, first.nextCursor ?? 0);
      expect(second.trades.map((item) => item.seq)).toEqual([3, 4]);

      const third = await runs.getTrades(run.id, 2, second.nextCursor ?? 0);
      expect(third.trades.map((item) => item.seq)).toEqual([5]);
      expect(third.nextCursor).toBeNull();
    });
  });

  describe('deleteRun', () => {
    it('borra el run y arrastra trades y equity en cascada', async () => {
      const run = await runs.createRun(runInput());
      await runs.markRunning(run.id, 100);
      await runs.completeRun({
        runId: run.id,
        metrics: METRICS,
        trades: [trade(1, 200)],
        equity: EQUITY,
      });

      expect(await runs.deleteRun(run.id)).toBe(true);
      expect(await runs.getRun(run.id)).toBeNull();

      const trades = await db.pool.query('SELECT count(*)::int AS n FROM backtest_trades WHERE run_id = $1', [run.id]);
      const equity = await db.pool.query('SELECT count(*)::int AS n FROM backtest_equity WHERE run_id = $1', [run.id]);
      expect(trades.rows[0]?.n).toBe(0);
      expect(equity.rows[0]?.n).toBe(0);
    });

    it('borrar un run inexistente devuelve false', async () => {
      expect(await runs.deleteRun('00000000-0000-4000-8000-000000000000')).toBe(false);
    });
  });
});
