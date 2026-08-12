import { randomUUID } from 'node:crypto';
import { runCancelKey, type Candle, type Timeframe } from '@tt/shared';
import type { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import {
  createCandlesRepository,
  type CandlesRepository,
} from '../db/repositories/candles.repo.js';
import {
  createRunsRepository,
  type CreateRunInput,
  type RunsRepository,
} from '../db/repositories/runs.repo.js';
import type { BacktestMetrics, EquityPoint, Trade } from '../engine/types.js';
import { createLogger } from '../observability/logger.js';
import { createBacktestQueue, type BacktestQueue } from '../queue/backtest.queue.js';
import { createRedisCancelFlags, type CancelFlagStore } from '../queue/cancel-flags.js';
import { createQueueConnection } from '../queue/connection.js';
import { createScratchDatabase, type ScratchDatabase } from '../testing/scratch-db.js';
import { backtestsRouter } from './routes/backtests.js';
import { createApiApp } from './server.js';

const QUEUE_PREFIX = `tt-itest-api-${randomUUID().slice(0, 8)}`;
const SYMBOL = 'BTCTEST';
const TIMEFRAME: Timeframe = '1h';
const STEP = 3_600_000;
const START = Date.UTC(2026, 0, 1);
const SEEDED_BARS = 200;
const MAX_BARS = 500_000;
const GENERATED_SEED = 4_242;

const EXEC = {
  initialCapital: 10_000,
  riskPerTradePct: 1,
  feeBps: 6,
  slippageBps: 2,
  fillModel: 'next-open',
} as const;

const PARAMS = {
  fastPeriod: 12,
  slowPeriod: 26,
  atrPeriod: 14,
  atrStopMult: 2,
  takeProfitR: 2,
  allowShort: true,
};

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    symbol: SYMBOL,
    timeframe: TIMEFRAME,
    from: new Date(START).toISOString(),
    to: new Date(START + 100 * STEP).toISOString(),
    strategyId: 'ema-cross',
    params: PARAMS,
    exec: EXEC,
    ...overrides,
  };
}

function makeCandle(index: number): Candle {
  const base = 100 + index;
  return { t: START + index * STEP, o: base, h: base + 1, l: base - 1, c: base + 0.5, v: 10 };
}

const METRICS: BacktestMetrics = {
  netProfit: 1843.21,
  netProfitPct: 18.43,
  maxDrawdown: 0.121,
  maxDrawdownQuote: 1204.55,
  winRate: 0.5,
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

function trade(seq: number): Trade {
  return {
    seq,
    side: seq % 2 === 0 ? 'short' : 'long',
    entryTs: START + seq * STEP,
    entryPrice: 100 + seq,
    exitTs: START + (seq + 1) * STEP,
    exitPrice: 105 + seq,
    qty: 10,
    fees: 1.5,
    pnlQuote: 50 * seq,
    pnlR: seq / 2,
    exitReason: 'signal',
    maeR: 0.2,
    mfeR: 1.1,
  };
}

const EQUITY: EquityPoint[] = [
  { t: START, equity: 10_000, drawdown: 0 },
  { t: START + STEP, equity: 10_500, drawdown: 0 },
  { t: START + 2 * STEP, equity: 10_200, drawdown: 0.0285714286 },
];

function requireRedisUrl(): string {
  const url = process.env.REDIS_URL;
  if (url === undefined || url === '') {
    throw new Error('REDIS_URL no esta definida. Copia .env.example a .env y ejecuta npm run db:up.');
  }
  return url;
}

describe('API de backtests', () => {
  let db: ScratchDatabase;
  let candles: CandlesRepository;
  let runs: RunsRepository;
  let connection: Redis;
  let queue: BacktestQueue;
  let cancelFlags: CancelFlagStore;

  beforeAll(async () => {
    db = await createScratchDatabase({ applicationName: 'tt-itest-api-backtests' });
    await runMigrations({ pool: db.pool });
    candles = createCandlesRepository(db.pool);
    runs = createRunsRepository(db.pool);
    connection = createQueueConnection(requireRedisUrl());
    queue = createBacktestQueue(connection, { prefix: QUEUE_PREFIX });
    cancelFlags = createRedisCancelFlags(connection);
    await queue.queue.obliterate({ force: true });
  });

  afterAll(async () => {
    const flags = await connection.keys(runCancelKey('*'));
    if (flags.length > 0) {
      await connection.del(...flags);
    }
    await queue.close();
    connection.disconnect();
    await db.drop();
  });

  beforeEach(async () => {
    await queue.queue.obliterate({ force: true });
    await db.pool.query('TRUNCATE backtest_runs CASCADE');
    await db.pool.query('TRUNCATE candles');
    await candles.upsertCandles({
      symbol: SYMBOL,
      timeframe: TIMEFRAME,
      source: 'rest',
      candles: Array.from({ length: SEEDED_BARS }, (_, index) => makeCandle(index)),
    });
  });

  afterEach(async () => {
    await queue.queue.obliterate({ force: true });
  });

  function makeApp() {
    const logger = createLogger({ role: 'api', level: 'silent' });
    return createApiApp({
      logger,
      webOrigin: 'https://terminal.example',
      version: '0.1.0',
      uptimeSec: () => 1,
      checkDb: () => Promise.resolve(),
      checkRedis: () => Promise.resolve(),
      registerRoutes: (router) => {
        router.use(
          backtestsRouter({
            runs,
            candles,
            queue,
            cancelFlags,
            logger,
            exchange: 'bitget',
            symbols: [SYMBOL],
            timeframes: ['1m', '15m', '1h'],
            maxBars: MAX_BARS,
            generateSeed: () => GENERATED_SEED,
          }),
        );
      },
    });
  }

  function runInput(overrides: Partial<CreateRunInput> = {}): CreateRunInput {
    return {
      exchange: 'bitget',
      symbol: SYMBOL,
      timeframe: TIMEFRAME,
      strategyId: 'ema-cross',
      params: PARAMS,
      exec: EXEC,
      seed: 7,
      rangeFrom: START,
      rangeTo: START + 100 * STEP,
      engineVersion: '1.0.0',
      barsTotal: 100,
      ...overrides,
    };
  }

  async function completedRun(overrides: Partial<CreateRunInput> = {}): Promise<string> {
    const run = await runs.createRun(runInput(overrides));
    await runs.markRunning(run.id, 100);
    await runs.completeRun({
      runId: run.id,
      metrics: METRICS,
      trades: [trade(1), trade(2), trade(3)],
      equity: EQUITY,
    });
    return run.id;
  }

  describe('POST /api/backtests', () => {
    it('happy path: 202 con runId, seed, paramsHash y barsTotal, y el job encolado', async () => {
      const pendingBefore = await queue.countPending();
      const response = await request(makeApp()).post('/api/backtests').send(body({ seed: 99 }));

      expect(response.status).toBe(202);
      expect(response.body.status).toBe('queued');
      expect(response.body.seed).toBe(99);
      expect(response.body.barsTotal).toBe(100);
      expect(response.body.paramsHash).toMatch(/^[0-9a-f]{64}$/);
      expect(response.body.warnings).toEqual([]);

      const stored = await runs.getRun(response.body.runId);
      expect(stored?.status).toBe('queued');
      expect(stored?.barsTotal).toBe(100);

      const job = await queue.queue.getJob(response.body.runId);
      expect(job?.data).toEqual({ runId: response.body.runId });
      expect(await queue.countPending()).toBe(pendingBefore + 1);
    });

    it('sin seed genera uno y lo devuelve persistido', async () => {
      const response = await request(makeApp()).post('/api/backtests').send(body());

      expect(response.status).toBe(202);
      expect(response.body.seed).toBe(GENERATED_SEED);
      expect((await runs.getRun(response.body.runId))?.seed).toBe(GENERATED_SEED);
    });

    it('rellena los defaults de la estrategia antes de calcular el paramsHash', async () => {
      const app = makeApp();

      const explicit = await request(app).post('/api/backtests').send(body({ seed: 5 }));
      const implicit = await request(app)
        .post('/api/backtests')
        .send(body({ seed: 5, params: { fastPeriod: 12, slowPeriod: 26 } }));

      expect(implicit.status).toBe(202);
      expect(implicit.body.paramsHash).toBe(explicit.body.paramsHash);
    });

    it('params fuera del rango de la estrategia dan 400 con la ruta del campo', async () => {
      const response = await request(makeApp())
        .post('/api/backtests')
        .send(body({ params: { ...PARAMS, fastPeriod: 1 } }));

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(response.body.error.details).toContainEqual(
        expect.objectContaining({ path: 'body.params.fastPeriod' }),
      );
    });

    it('el refinamiento slowPeriod > fastPeriod tambien sale con su ruta', async () => {
      const response = await request(makeApp())
        .post('/api/backtests')
        .send(body({ params: { ...PARAMS, fastPeriod: 30, slowPeriod: 10 } }));

      expect(response.status).toBe(400);
      expect(response.body.error.details[0].path).toBe('body.params.slowPeriod');
    });

    it('un rango con demasiadas velas da 413', async () => {
      const pendingBefore = await queue.countPending();
      const response = await request(makeApp())
        .post('/api/backtests')
        .send(
          body({
            timeframe: '1m',
            from: new Date(Date.UTC(2020, 0, 1)).toISOString(),
            to: new Date(Date.UTC(2026, 0, 1)).toISOString(),
          }),
        );

      expect(response.status).toBe(413);
      expect(response.body.error.code).toBe('RANGE_TOO_LARGE');
      expect(await queue.countPending()).toBe(pendingBefore);
    });

    it('un rango con huecos se acepta con warnings coverage-gaps', async () => {
      await db.pool.query('DELETE FROM candles WHERE ts = $1', [new Date(START + 40 * STEP)]);

      const response = await request(makeApp()).post('/api/backtests').send(body());

      expect(response.status).toBe(202);
      expect(response.body.warnings).toEqual(['coverage-gaps']);
    });

    it('un rango sin cobertura por delante tambien avisa', async () => {
      const response = await request(makeApp())
        .post('/api/backtests')
        .send(
          body({
            from: new Date(START + 150 * STEP).toISOString(),
            to: new Date(START + 300 * STEP).toISOString(),
          }),
        );

      expect(response.status).toBe(202);
      expect(response.body.warnings).toEqual(['coverage-gaps']);
    });

    it('una estrategia desconocida da 404', async () => {
      const response = await request(makeApp())
        .post('/api/backtests')
        .send(body({ strategyId: 'no-existe' }));

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });

    it('un simbolo no servido da 404', async () => {
      const response = await request(makeApp())
        .post('/api/backtests')
        .send(body({ symbol: 'NOPEUSDT' }));

      expect(response.status).toBe(404);
    });

    it('un rango invertido da 400', async () => {
      const response = await request(makeApp())
        .post('/api/backtests')
        .send(body({ from: new Date(START + 10 * STEP).toISOString(), to: new Date(START).toISOString() }));

      expect(response.status).toBe(400);
      expect(response.body.error.details[0].path).toBe('body.to');
    });

    it('un exec incompleto da 400 con la ruta del campo que falta', async () => {
      const response = await request(makeApp())
        .post('/api/backtests')
        .send(body({ exec: { initialCapital: 10_000, riskPerTradePct: 1, feeBps: 6 } }));

      expect(response.status).toBe(400);
      expect(response.body.error.details[0].path).toBe('body.exec.slippageBps');
    });
  });

  describe('GET /api/backtests', () => {
    it('lista los runs mas recientes primero y filtra por estado', async () => {
      const first = await runs.createRun(runInput({ label: 'primero' }));
      const second = await runs.createRun(runInput({ label: 'segundo', seed: 8 }));
      await runs.markRunning(second.id, 100);
      await runs.completeRun({ runId: second.id, metrics: METRICS, trades: [], equity: [] });

      const all = await request(makeApp()).get('/api/backtests');
      expect(all.status).toBe(200);
      expect(all.body.runs).toHaveLength(2);
      expect(all.body.runs[0].id).toBe(second.id);
      expect(all.body.runs[1].id).toBe(first.id);

      const completed = await request(makeApp()).get('/api/backtests?status=completed');
      expect(completed.body.runs).toHaveLength(1);
      expect(completed.body.runs[0].id).toBe(second.id);
      expect(completed.body.runs[0].metrics.netProfit).toBe('1843.21');
    });

    it('respeta limit y offset', async () => {
      await runs.createRun(runInput());
      await runs.createRun(runInput({ seed: 8 }));
      await runs.createRun(runInput({ seed: 9 }));

      const page = await request(makeApp()).get('/api/backtests?limit=2&offset=1');

      expect(page.body.runs).toHaveLength(2);
    });

    it('un status inexistente da 400', async () => {
      const response = await request(makeApp()).get('/api/backtests?status=zombie');

      expect(response.status).toBe(400);
      expect(response.body.error.details[0].path).toBe('query.status');
    });
  });

  describe('GET /api/backtests/:id', () => {
    it('devuelve el detalle con params, exec, metricas y tiempos', async () => {
      const runId = await completedRun();

      const response = await request(makeApp()).get(`/api/backtests/${runId}`);

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(runId);
      expect(response.body.status).toBe('completed');
      expect(response.body.params).toEqual(PARAMS);
      expect(response.body.exec).toEqual(EXEC);
      expect(response.body.range.from).toBe(new Date(START).toISOString());
      expect(response.body.metrics.maxDrawdownQuote).toBe('1204.55');
      expect(response.body.metrics.netProfitPct).toBe(18.43);
      expect(response.body.timings.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('un run inexistente da 404 y un id que no es uuid da 400', async () => {
      const missing = await request(makeApp()).get(`/api/backtests/${randomUUID()}`);
      expect(missing.status).toBe(404);

      const malformed = await request(makeApp()).get('/api/backtests/no-soy-uuid');
      expect(malformed.status).toBe(400);
      expect(malformed.body.error.details[0].path).toBe('params.id');
    });
  });

  describe('GET /api/backtests/:id/trades', () => {
    it('devuelve los trades con precios en string y pagina por cursor', async () => {
      const runId = await completedRun();

      const first = await request(makeApp()).get(`/api/backtests/${runId}/trades?limit=2`);

      expect(first.status).toBe(200);
      expect(first.body.trades).toHaveLength(2);
      expect(first.body.trades[0]).toMatchObject({
        seq: 1,
        side: 'long',
        entryPrice: '101',
        pnlR: 0.5,
        exitReason: 'signal',
      });
      expect(first.body.nextCursor).toBe(2);

      const second = await request(makeApp()).get(
        `/api/backtests/${runId}/trades?limit=2&cursor=2`,
      );
      expect(second.body.trades).toHaveLength(1);
      expect(second.body.trades[0].seq).toBe(3);
      expect(second.body.nextCursor).toBeNull();
    });

    it('un run inexistente da 404', async () => {
      const response = await request(makeApp()).get(`/api/backtests/${randomUUID()}/trades`);
      expect(response.status).toBe(404);
    });
  });

  describe('GET /api/backtests/:id/equity', () => {
    it('devuelve la curva con equity en string y dd numerico', async () => {
      const runId = await completedRun();

      const response = await request(makeApp()).get(`/api/backtests/${runId}/equity`);

      expect(response.status).toBe(200);
      expect(response.body.points).toHaveLength(3);
      expect(response.body.points[0]).toEqual({ t: START, equity: '10000', dd: 0 });
      expect(response.body.points[2].dd).toBeCloseTo(0.028571, 6);
    });
  });

  describe('GET /api/backtests/compare', () => {
    it('normaliza las curvas a base 100 y alinea las metricas', async () => {
      const a = await completedRun();
      const b = await completedRun({ seed: 8 });

      const response = await request(makeApp()).get(`/api/backtests/compare?ids=${a},${b}`);

      expect(response.status).toBe(200);
      expect(response.body.runs).toHaveLength(2);
      expect(response.body.curves).toHaveLength(2);
      expect(response.body.curves[0].points[0].value).toBe(100);
      expect(response.body.curves[0].points[1].value).toBe(105);
      expect(response.body.curves[0].points[2].value).toBe(102);
      expect(response.body.warnings).toEqual([]);
    });

    it('runs con engineVersion distinta avisan del desajuste', async () => {
      const a = await completedRun();
      const b = await completedRun({ seed: 8, engineVersion: '0.9.0' });

      const response = await request(makeApp()).get(`/api/backtests/compare?ids=${a},${b}`);

      expect(response.status).toBe(200);
      expect(response.body.warnings).toEqual(['engine-version-mismatch']);
    });

    it('cinco ids dan 400', async () => {
      const ids = Array.from({ length: 5 }, () => randomUUID()).join(',');

      const response = await request(makeApp()).get(`/api/backtests/compare?ids=${ids}`);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(response.body.error.details[0].path).toBe('query.ids');
    });

    it('un id inexistente da 404', async () => {
      const a = await completedRun();

      const response = await request(makeApp()).get(
        `/api/backtests/compare?ids=${a},${randomUUID()}`,
      );

      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/backtests/:id/cancel', () => {
    it('un run en cola se cancela y sale de la cola', async () => {
      const pendingBefore = await queue.countPending();
      const created = await request(makeApp()).post('/api/backtests').send(body());
      const runId: string = created.body.runId;
      expect(await queue.countPending()).toBe(pendingBefore + 1);

      const response = await request(makeApp()).post(`/api/backtests/${runId}/cancel`);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ runId, status: 'cancelled' });
      expect(await queue.queue.getJob(runId)).toBeUndefined();
      expect(await queue.countPending()).toBe(pendingBefore);
      expect((await runs.getRun(runId))?.status).toBe('cancelled');
      expect(await cancelFlags.isRequested(runId)).toBe(true);
    });

    it('un run en curso deja la flag de cancelacion para el worker', async () => {
      const run = await runs.createRun(runInput());
      await runs.markRunning(run.id, 100);

      const response = await request(makeApp()).post(`/api/backtests/${run.id}/cancel`);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ runId: run.id, status: 'running' });
      expect(await cancelFlags.isRequested(run.id)).toBe(true);
      expect((await runs.getRun(run.id))?.status).toBe('running');
    });

    it('cancelar un run terminado da 409', async () => {
      const runId = await completedRun();

      const response = await request(makeApp()).post(`/api/backtests/${runId}/cancel`);

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('CONFLICT');
    });

    it('cancelar un run inexistente da 404', async () => {
      const response = await request(makeApp()).post(`/api/backtests/${randomUUID()}/cancel`);
      expect(response.status).toBe(404);
    });
  });

  describe('DELETE /api/backtests/:id', () => {
    it('borra el run con sus trades y su curva', async () => {
      const runId = await completedRun();

      const response = await request(makeApp()).delete(`/api/backtests/${runId}`);

      expect(response.status).toBe(204);
      expect(response.body).toEqual({});
      expect(await runs.getRun(runId)).toBeNull();

      const trades = await db.pool.query('SELECT 1 FROM backtest_trades WHERE run_id = $1', [
        runId,
      ]);
      const equity = await db.pool.query('SELECT 1 FROM backtest_equity WHERE run_id = $1', [
        runId,
      ]);
      expect(trades.rowCount).toBe(0);
      expect(equity.rowCount).toBe(0);
    });

    it('borrar un run en cola lo saca tambien de la cola', async () => {
      const pendingBefore = await queue.countPending();
      const created = await request(makeApp()).post('/api/backtests').send(body());
      const runId: string = created.body.runId;
      expect(await queue.countPending()).toBe(pendingBefore + 1);

      const response = await request(makeApp()).delete(`/api/backtests/${runId}`);

      expect(response.status).toBe(204);
      expect(await queue.countPending()).toBe(pendingBefore);
      expect(await queue.queue.getJob(runId)).toBeUndefined();
    });

    it('borrar dos veces da 404 la segunda', async () => {
      const runId = await completedRun();

      expect((await request(makeApp()).delete(`/api/backtests/${runId}`)).status).toBe(204);
      expect((await request(makeApp()).delete(`/api/backtests/${runId}`)).status).toBe(404);
    });
  });
});
