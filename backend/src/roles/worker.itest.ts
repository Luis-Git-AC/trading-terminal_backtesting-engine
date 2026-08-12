import { randomUUID } from 'node:crypto';
import { runCancelKey, type Candle, type Timeframe } from '@tt/shared';
import { Redis } from 'ioredis';
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
import type { ExecConfig } from '../engine/types.js';
import { createLogger } from '../observability/logger.js';
import { createBacktestQueue, type BacktestQueue } from '../queue/backtest.queue.js';
import { createRedisCancelFlags } from '../queue/cancel-flags.js';
import { createQueueConnection } from '../queue/connection.js';
import { getStrategy } from '../strategies/registry.js';
import { explosiveStrategy } from '../testing/explosive-strategy.js';
import { createScratchDatabase, type ScratchDatabase } from '../testing/scratch-db.js';
import { startWorker, type StartWorkerOptions, type WorkerHandle } from './worker.js';

const QUEUE_PREFIX = `tt-itest-worker-${randomUUID().slice(0, 8)}`;
const SYMBOL = 'ROLETEST';
const TIMEFRAME: Timeframe = '1m';
const STEP = 60_000;
const START = Date.UTC(2026, 0, 1);
const BARS = 6_000;

const EXEC: ExecConfig = {
  initialCapital: 10_000,
  riskPerTradePct: 1,
  feeBps: 6,
  slippageBps: 2,
  fillModel: 'next-open',
};

const PARAMS = { fastPeriod: 12, slowPeriod: 26 };

function makeCandle(index: number): Candle {
  const wave = 200 * Math.sin(index / 37) + 60 * Math.sin(index / 7.3);
  const close = 30_000 + wave;
  const open = 30_000 + (200 * Math.sin((index - 1) / 37) + 60 * Math.sin((index - 1) / 7.3));
  return {
    t: START + index * STEP,
    o: Number(open.toFixed(2)),
    h: Number((Math.max(open, close) + 15).toFixed(2)),
    l: Number((Math.min(open, close) - 15).toFixed(2)),
    c: Number(close.toFixed(2)),
    v: 10,
  };
}

function requireRedisUrl(): string {
  const url = process.env.REDIS_URL;
  if (url === undefined || url === '') {
    throw new Error('REDIS_URL no esta definida. Copia .env.example a .env y ejecuta npm run db:up.');
  }
  return url;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) {
      throw new Error('waitFor: se agoto el tiempo esperando la condicion');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('rol worker', () => {
  let db: ScratchDatabase;
  let candles: CandlesRepository;
  let runs: RunsRepository;
  let queueConnection: Redis;
  let queue: BacktestQueue;
  let flagsRedis: Redis;

  const logger = createLogger({ role: 'worker', level: 'silent' });
  const handles: WorkerHandle[] = [];

  beforeAll(async () => {
    db = await createScratchDatabase({ applicationName: 'tt-itest-role-worker' });
    await runMigrations({ pool: db.pool });
    candles = createCandlesRepository(db.pool);
    runs = createRunsRepository(db.pool);
    queueConnection = createQueueConnection(requireRedisUrl());
    queue = createBacktestQueue(queueConnection, { prefix: QUEUE_PREFIX });
    flagsRedis = new Redis(requireRedisUrl(), { maxRetriesPerRequest: null });
    await queue.queue.obliterate({ force: true });

    await candles.upsertCandles({
      symbol: SYMBOL,
      timeframe: TIMEFRAME,
      source: 'rest',
      candles: Array.from({ length: BARS }, (_, index) => makeCandle(index)),
    });
  });

  afterEach(async () => {
    while (handles.length > 0) {
      await handles.pop()?.stop({ force: true, reason: 'fin de test' });
    }
    await queue.queue.obliterate({ force: true });
    const stale = await flagsRedis.keys(runCancelKey('*'));
    if (stale.length > 0) {
      await flagsRedis.del(...stale);
    }
  });

  afterAll(async () => {
    await queue.close();
    queueConnection.disconnect();
    flagsRedis.disconnect();
    await db.drop();
  });

  beforeEach(async () => {
    await db.pool.query('TRUNCATE backtest_runs CASCADE');
    await queue.queue.obliterate({ force: true });
  });

  async function startTestWorker(
    overrides: Partial<StartWorkerOptions> = {},
  ): Promise<WorkerHandle> {
    const handle = await startWorker({
      pool: db.pool,
      connection: createQueueConnection(requireRedisUrl()),
      redis: new Redis(requireRedisUrl(), { maxRetriesPerRequest: null }),
      logger,
      concurrency: 2,
      prefix: QUEUE_PREFIX,
      closePool: false,
      signals: [],
      progressEveryBars: 1_000,
      cancelPollMs: 25,
      abortGraceMs: 3_000,
      ...overrides,
    });
    handles.push(handle);
    return handle;
  }

  function runInput(overrides: Partial<CreateRunInput> = {}): CreateRunInput {
    return {
      exchange: 'bitget',
      symbol: SYMBOL,
      timeframe: TIMEFRAME,
      strategyId: 'ema-cross',
      params: PARAMS,
      exec: EXEC,
      seed: 42,
      rangeFrom: START,
      rangeTo: START + BARS * STEP,
      engineVersion: '1.0.0',
      barsTotal: BARS,
      ...overrides,
    };
  }

  it('consume un job real de la cola y deja el run completado', async () => {
    await startTestWorker();
    const run = await runs.createRun(runInput());

    await queue.enqueue({ runId: run.id });

    await waitFor(async () => (await runs.getRun(run.id))?.status === 'completed');

    const stored = await runs.getRun(run.id);
    expect(stored?.metrics?.barsTotal).toBe(BARS);
    expect((await runs.getEquity(run.id)).length).toBeGreaterThan(0);
  });

  it('usa la concurrencia configurada y vacia varios jobs', async () => {
    const handle = await startTestWorker({ concurrency: 2 });
    expect(handle.worker.concurrency).toBe(2);

    const first = await runs.createRun(runInput());
    const second = await runs.createRun(runInput({ seed: 43 }));
    await queue.enqueue({ runId: first.id });
    await queue.enqueue({ runId: second.id });

    await waitFor(async () => {
      const a = await runs.getRun(first.id);
      const b = await runs.getRun(second.id);
      return a?.status === 'completed' && b?.status === 'completed';
    });
    await waitFor(async () => (await queue.countPending()) === 0);
  });

  it('una estrategia que revienta deja el run failed y el worker sigue consumiendo', async () => {
    const explosive = explosiveStrategy('boom en la barra 3');

    await startTestWorker({
      getStrategy: (id: string) => (id === 'boom' ? explosive : getStrategy(id)),
    });

    const broken = await runs.createRun(runInput({ strategyId: 'boom' }));
    await queue.enqueue({ runId: broken.id });
    await waitFor(async () => (await runs.getRun(broken.id))?.status === 'failed');

    const failed = await runs.getRun(broken.id);
    expect(failed?.error).toBe('boom en la barra 3');

    const healthy = await runs.createRun(runInput({ seed: 44 }));
    await queue.enqueue({ runId: healthy.id });
    await waitFor(async () => (await runs.getRun(healthy.id))?.status === 'completed');

    expect((await runs.getRun(healthy.id))?.metrics).not.toBeNull();
  });

  it('la flag de cancelacion en Redis para el run en curso', async () => {
    const gate = deferred();
    await startTestWorker({
      candles: slowCandles(candles, 1, gate.promise),
      cancelPollMs: 10,
    });
    const cancelFlags = createRedisCancelFlags(flagsRedis);
    const run = await runs.createRun(runInput());

    await queue.enqueue({ runId: run.id });
    await waitFor(async () => (await runs.getRun(run.id))?.status === 'running');

    await cancelFlags.request(run.id);
    await new Promise((resolve) => setTimeout(resolve, 60));
    gate.resolve();

    await waitFor(async () => (await runs.getRun(run.id))?.status === 'cancelled');

    expect((await runs.getTrades(run.id)).trades).toEqual([]);
    expect(await runs.getEquity(run.id)).toEqual([]);
  });

  it('si el job agota sus intentos el run queda failed, nunca colgado en running', async () => {
    const broken: RunsRepository = {
      ...runs,
      getRun: (runId: string) =>
        runId === blocked ? Promise.reject(new Error('BD caida')) : runs.getRun(runId),
    };
    let blocked = '';
    await startTestWorker({ runs: broken });

    const run = await runs.createRun(runInput());
    blocked = run.id;
    await queue.enqueue({ runId: run.id });

    await waitFor(async () => (await runs.getRun(run.id))?.status === 'failed', 20_000);

    const stored = await runs.getRun(run.id);
    expect(stored?.error).toBe('BD caida');
    expect(stored?.finishedAt).not.toBeNull();
  });

  it('un apagado forzado con un job en curso devuelve el run a la cola y otro worker lo termina', async () => {
    const gate = deferred();
    const handle = await startTestWorker({ candles: slowCandles(candles, 1, gate.promise) });
    const run = await runs.createRun(runInput());

    await queue.enqueue({ runId: run.id });
    await waitFor(async () => (await runs.getRun(run.id))?.status === 'running');
    expect(handle.activeRuns()).toEqual([run.id]);

    const stopping = handle.stop({ force: true, reason: 'SIGTERM' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    gate.resolve();
    await stopping;

    const stored = await runs.getRun(run.id);
    expect(stored?.status).toBe('queued');
    expect(stored?.startedAt).toBeNull();
    expect(stored?.barsDone).toBe(0);
    expect((await runs.getTrades(run.id)).trades).toEqual([]);

    await queue.remove(run.id);
    await startTestWorker();
    await queue.enqueue({ runId: run.id });

    await waitFor(async () => (await runs.getRun(run.id))?.status === 'completed');
    expect((await runs.getRun(run.id))?.metrics).not.toBeNull();
  });

  it('un apagado limpio espera a que el job en curso termine', async () => {
    const gate = deferred();
    const handle = await startTestWorker({ candles: slowCandles(candles, 1, gate.promise) });
    const run = await runs.createRun(runInput());

    await queue.enqueue({ runId: run.id });
    await waitFor(async () => (await runs.getRun(run.id))?.status === 'running');

    const stopping = handle.stop({ reason: 'apagado limpio' });
    gate.resolve();
    await stopping;

    expect((await runs.getRun(run.id))?.status).toBe('completed');
    expect(handle.activeRuns()).toEqual([]);
  });
});

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve: () => { resolve(); } };
}

function slowCandles(
  repo: CandlesRepository,
  afterCalls: number,
  gate: Promise<void>,
): CandlesRepository {
  let calls = 0;
  return {
    ...repo,
    async getCandles(query) {
      calls += 1;
      if (calls > afterCalls) {
        await gate;
      }
      return await repo.getCandles(query);
    },
  };
}
