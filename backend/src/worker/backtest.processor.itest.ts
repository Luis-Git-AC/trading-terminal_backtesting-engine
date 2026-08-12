import { randomUUID } from 'node:crypto';
import { runChannel, type Candle, type RunEvent, type Timeframe } from '@tt/shared';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { createRunEventPublisher } from '../queue/pubsub.js';
import { explosiveStrategy } from '../testing/explosive-strategy.js';
import { createScratchDatabase, type ScratchDatabase } from '../testing/scratch-db.js';
import {
  processBacktest,
  type AbortWatch,
  type BacktestProcessorDeps,
} from './backtest.processor.js';

const SYMBOL = 'WRKTEST';
const TIMEFRAME: Timeframe = '1m';
const STEP = 60_000;
const START = Date.UTC(2026, 0, 1);
const BARS = 10_000;

const EXEC: ExecConfig = {
  initialCapital: 10_000,
  riskPerTradePct: 1,
  feeBps: 6,
  slippageBps: 2,
  fillModel: 'next-open',
};

const PARAMS = {
  fastPeriod: 12,
  slowPeriod: 26,
  atrPeriod: 14,
  atrStopMult: 2,
  takeProfitR: 2,
  allowShort: true,
};

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
    v: 10 + (index % 5),
  };
}

function requireRedisUrl(): string {
  const url = process.env.REDIS_URL;
  if (url === undefined || url === '') {
    throw new Error('REDIS_URL no esta definida. Copia .env.example a .env y ejecuta npm run db:up.');
  }
  return url;
}

const NEVER_ABORTS: AbortWatch = { reason: () => null, stop: () => undefined };

function watchAfter(calls: number, reason: 'cancelled' | 'stopping'): AbortWatch {
  let seen = 0;
  return {
    reason: () => {
      seen += 1;
      return seen >= calls ? reason : null;
    },
    stop: () => undefined,
  };
}

describe('backtest processor', () => {
  let db: ScratchDatabase;
  let candles: CandlesRepository;
  let runs: RunsRepository;
  let redis: Redis;
  let subscriber: Redis;

  const logger = createLogger({ role: 'worker', level: 'silent' });

  beforeAll(async () => {
    db = await createScratchDatabase({ applicationName: 'tt-itest-backtest-processor' });
    await runMigrations({ pool: db.pool });
    candles = createCandlesRepository(db.pool);
    runs = createRunsRepository(db.pool);
    redis = new Redis(requireRedisUrl(), { maxRetriesPerRequest: null });
    subscriber = new Redis(requireRedisUrl(), { maxRetriesPerRequest: null });

    await candles.upsertCandles({
      symbol: SYMBOL,
      timeframe: TIMEFRAME,
      source: 'rest',
      candles: Array.from({ length: BARS }, (_, index) => makeCandle(index)),
    });
  });

  afterAll(async () => {
    subscriber.disconnect();
    redis.disconnect();
    await db.drop();
  });

  beforeEach(async () => {
    await db.pool.query('TRUNCATE backtest_runs CASCADE');
  });

  function makeDeps(overrides: Partial<BacktestProcessorDeps> = {}): BacktestProcessorDeps {
    return {
      runs,
      candles,
      publisher: createRunEventPublisher({ redis }),
      logger,
      createWatch: () => NEVER_ABORTS,
      progressEveryBars: 1_000,
      progressMinIntervalMs: 0,
      ...overrides,
    };
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

  async function collectEvents(runId: string, body: () => Promise<void>): Promise<RunEvent[]> {
    const events: RunEvent[] = [];
    const channel = runChannel(runId);
    subscriber.on('message', (received: string, payload: string) => {
      if (received === channel) {
        events.push(JSON.parse(payload) as RunEvent);
      }
    });
    await subscriber.subscribe(channel);
    try {
      await body();
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      await subscriber.unsubscribe(channel);
      subscriber.removeAllListeners('message');
    }
    return events;
  }

  it('un run de 10.000 velas se completa y persiste metricas, trades y curva', async () => {
    const run = await runs.createRun(runInput());

    const report = await processBacktest(makeDeps(), { runId: run.id });

    expect(report.outcome).toBe('completed');
    expect(report.barsLoaded).toBe(BARS);
    expect(report.trades).toBeGreaterThan(0);

    const stored = await runs.getRun(run.id);
    expect(stored?.status).toBe('completed');
    expect(stored?.startedAt).not.toBeNull();
    expect(stored?.finishedAt).not.toBeNull();
    expect(stored?.metrics?.barsTotal).toBe(BARS);
    expect(stored?.metrics?.trades).toBe(report.trades);

    const trades = await runs.getTrades(run.id, 1_000);
    expect(trades.trades).toHaveLength(report.trades);
    expect(trades.trades[0]?.seq).toBe(1);

    const equity = await runs.getEquity(run.id);
    expect(equity.length).toBeGreaterThan(0);
    expect(equity[0]?.equity).toBe(EXEC.initialCapital);
  });

  it('publica status, progreso creciente y done por el canal del run', async () => {
    const run = await runs.createRun(runInput());

    const events = await collectEvents(run.id, async () => {
      await processBacktest(makeDeps(), { runId: run.id });
    });

    const kinds = events.map((event) => event.type);
    expect(kinds[0]).toBe('status');
    expect(kinds.at(-1)).toBe('done');

    const progress = events.filter((event) => event.type === 'progress');
    expect(progress.length).toBeGreaterThanOrEqual(9);
    for (let i = 1; i < progress.length; i += 1) {
      expect(progress[i]!.barsDone).toBeGreaterThan(progress[i - 1]!.barsDone);
      expect(progress[i]!.pct).toBeGreaterThan(progress[i - 1]!.pct);
    }
    expect(progress.at(-1)?.barsDone).toBe(BARS);

    const done = events.at(-1);
    expect(done).toEqual({ type: 'done', runId: run.id, status: 'completed' });
  });

  it('el progreso se publica como maximo 5 veces por segundo', async () => {
    const run = await runs.createRun(runInput());
    let clock = 1_000;

    const events = await collectEvents(run.id, async () => {
      await processBacktest(
        makeDeps({
          progressMinIntervalMs: 200,
          now: () => {
            clock += 50;
            return clock;
          },
        }),
        { runId: run.id },
      );
    });

    const progress = events.filter((event) => event.type === 'progress');
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.length).toBeLessThanOrEqual(4);
  });

  it('persiste bars_done por tramos, no una escritura por barra', async () => {
    const run = await runs.createRun(runInput());
    const updateProgress = vi.fn(runs.updateProgress.bind(runs));

    await processBacktest(makeDeps({ runs: { ...runs, updateProgress } }), { runId: run.id });

    expect(updateProgress.mock.calls.length).toBeGreaterThan(0);
    expect(updateProgress.mock.calls.length).toBeLessThanOrEqual(BARS / 1_000);
    const written = updateProgress.mock.calls.map(([, barsDone]) => barsDone);
    expect([...written].sort((a, b) => a - b)).toEqual(written);
  });

  it('submuestrea la curva antes de persistirla', async () => {
    const run = await runs.createRun(runInput());

    await processBacktest(makeDeps({ equityMaxPoints: 20 }), { runId: run.id });

    const equity = await runs.getEquity(run.id);
    expect(equity.length).toBeGreaterThan(0);
    expect(equity.length).toBeLessThanOrEqual(20);
  });

  it('dos runs con el mismo paramsHash dan metricas identicas leidas de la base de datos', async () => {
    const first = await runs.createRun(runInput());
    const second = await runs.createRun(runInput());
    expect(second.paramsHash).toBe(first.paramsHash);

    await processBacktest(makeDeps(), { runId: first.id });
    await processBacktest(makeDeps(), { runId: second.id });

    const storedFirst = await runs.getRun(first.id);
    const storedSecond = await runs.getRun(second.id);
    expect(storedSecond?.metrics).toEqual(storedFirst?.metrics);

    const tradesFirst = await runs.getTrades(first.id, 1_000);
    const tradesSecond = await runs.getTrades(second.id, 1_000);
    expect(tradesSecond.trades).toEqual(tradesFirst.trades);

    const equityFirst = await runs.getEquity(first.id);
    const equitySecond = await runs.getEquity(second.id);
    expect(equitySecond).toEqual(equityFirst);
  });

  it('una cancelacion a mitad deja el run cancelled sin resultados parciales', async () => {
    const run = await runs.createRun(runInput());
    const startedAt = Date.now();

    const report = await processBacktest(
      makeDeps({ createWatch: () => watchAfter(6, 'cancelled') }),
      { runId: run.id },
    );

    expect(report.outcome).toBe('cancelled');
    expect(Date.now() - startedAt).toBeLessThan(2_000);

    const stored = await runs.getRun(run.id);
    expect(stored?.status).toBe('cancelled');
    expect(stored?.metrics).toBeNull();
    expect((await runs.getTrades(run.id)).trades).toEqual([]);
    expect(await runs.getEquity(run.id)).toEqual([]);
  });

  it('la cancelacion publica un done con estado cancelled', async () => {
    const run = await runs.createRun(runInput());

    const events = await collectEvents(run.id, async () => {
      await processBacktest(makeDeps({ createWatch: () => watchAfter(6, 'cancelled') }), {
        runId: run.id,
      });
    });

    expect(events.at(-1)).toEqual({ type: 'done', runId: run.id, status: 'cancelled' });
  });

  it('un apagado a mitad devuelve el run a la cola sin persistir nada', async () => {
    const run = await runs.createRun(runInput());

    const report = await processBacktest(
      makeDeps({ createWatch: () => watchAfter(6, 'stopping') }),
      { runId: run.id },
    );

    expect(report.outcome).toBe('requeued');

    const stored = await runs.getRun(run.id);
    expect(stored?.status).toBe('queued');
    expect(stored?.startedAt).toBeNull();
    expect(stored?.barsDone).toBe(0);
    expect(stored?.metrics).toBeNull();
    expect((await runs.getTrades(run.id)).trades).toEqual([]);
  });

  it('una estrategia que revienta deja el run failed con el mensaje saneado', async () => {
    const run = await runs.createRun(runInput());
    const explosive = explosiveStrategy('la estrategia\n  reventó   en la barra 7');

    const events = await collectEvents(run.id, async () => {
      const report = await processBacktest(
        makeDeps({ getStrategy: () => explosive }),
        { runId: run.id },
      );
      expect(report.outcome).toBe('failed');
      expect(report.error).toBe('la estrategia reventó en la barra 7');
    });

    const stored = await runs.getRun(run.id);
    expect(stored?.status).toBe('failed');
    expect(stored?.error).toBe('la estrategia reventó en la barra 7');
    expect(stored?.finishedAt).not.toBeNull();
    expect((await runs.getTrades(run.id)).trades).toEqual([]);

    expect(events.some((event) => event.type === 'error')).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'done', runId: run.id, status: 'failed' });
  });

  it('una serie desalineada en la base de datos hace fallar el run, no el proceso', async () => {
    const run = await runs.createRun(
      runInput({ rangeFrom: START, rangeTo: START + 100 * STEP, barsTotal: 100 }),
    );
    await db.pool.query(
      `INSERT INTO candles (exchange, symbol, timeframe, ts, open, high, low, close, volume, source)
       VALUES ('bitget', $1, $2, $3, 1, 1, 1, 1, 1, 'rest')`,
      [SYMBOL, TIMEFRAME, new Date(START + 30_000)],
    );

    try {
      const report = await processBacktest(makeDeps(), { runId: run.id });

      expect(report.outcome).toBe('failed');
      expect(report.error).toContain('no esta alineada');
      expect((await runs.getRun(run.id))?.status).toBe('failed');
    } finally {
      await db.pool.query('DELETE FROM candles WHERE ts = $1', [new Date(START + 30_000)]);
    }
  });

  it('un job cuyo run no existe se descarta sin tocar nada', async () => {
    const report = await processBacktest(makeDeps(), { runId: randomUUID() });

    expect(report.outcome).toBe('skipped');
  });

  it('un run que ya no esta en cola se descarta', async () => {
    const run = await runs.createRun(runInput());
    await runs.cancelRun(run.id);

    const report = await processBacktest(makeDeps(), { runId: run.id });

    expect(report.outcome).toBe('skipped');
    expect((await runs.getRun(run.id))?.status).toBe('cancelled');
  });

  it('avisa del total real de velas cuando difiere del estimado al crear el run', async () => {
    const run = await runs.createRun(
      runInput({ rangeFrom: START, rangeTo: START + 20_000 * STEP, barsTotal: 20_000 }),
    );

    const events = await collectEvents(run.id, async () => {
      await processBacktest(makeDeps(), { runId: run.id });
    });

    const statuses = events.filter((event) => event.type === 'status');
    expect(statuses).toHaveLength(2);
    expect(statuses[0]?.barsTotal).toBe(20_000);
    expect(statuses[1]?.barsTotal).toBe(BARS);
  });
});
