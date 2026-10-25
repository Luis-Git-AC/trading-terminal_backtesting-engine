import type { Candle, Timeframe } from '@tt/shared';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import { createCandlesRepository } from '../db/repositories/candles.repo.js';
import { createEventsRepository, type EventsRepository } from '../db/repositories/events.repo.js';
import {
  createRunsRepository,
  type CreateRunInput,
  type RunsRepository,
} from '../db/repositories/runs.repo.js';
import type { ExecConfig } from '../engine/types.js';
import { createLogger } from '../observability/logger.js';
import { createRunEventPublisher } from '../queue/pubsub.js';
import { createScratchDatabase, type ScratchDatabase } from '../testing/scratch-db.js';
import {
  processBacktest,
  type AbortWatch,
  type BacktestProcessorDeps,
} from './backtest.processor.js';
import { resolveBlockedWindows } from './candle-loader.js';

const SYMBOL = 'BLKTEST';
const TIMEFRAME: Timeframe = '1m';
const MIN = 60_000;
const START = Date.UTC(2026, 0, 1);
const BARS = 10_000;
const MARGIN = 120 * MIN;

const EXPLICIT = { from: START + 100 * MIN, to: START + 200 * MIN };

const EXEC: ExecConfig = {
  initialCapital: 10_000,
  riskPerTradePct: 1,
  feeBps: 6,
  slippageBps: 2,
  fillModel: 'next-open',
  blockedWindows: [EXPLICIT],
  eventBlackout: { types: ['fred-release'], beforeMs: MARGIN, afterMs: MARGIN },
};

const PARAMS = { fastPeriod: 5, slowPeriod: 13, atrPeriod: 14, atrStopMult: 2, takeProfitR: 2 };

const BEFORE = START - 86_400_000;

/** Datos SINTETICOS: calendario de eventos inventado para este test. */
const EVENTS = [
  { type: 'fred-release', at: 2_000, fetchedAt: BEFORE },
  { type: 'eia-wpsr', at: 5_000, fetchedAt: BEFORE },
  { type: 'fred-release', at: 7_000, fetchedAt: START + 60 * MIN },
  { type: 'fred-release', at: 7_100, fetchedAt: BEFORE },
  { type: 'fred-release', at: 7_150, fetchedAt: BEFORE },
] as const;

const EXPECTED = [
  EXPLICIT,
  { from: START + 2_000 * MIN - MARGIN, to: START + 2_000 * MIN + MARGIN },
  { from: START + 7_100 * MIN - MARGIN, to: START + 7_150 * MIN + MARGIN },
];

function makeCandle(index: number): Candle {
  const close = 30_000 + 200 * Math.sin(index / 37) + 60 * Math.sin(index / 7.3);
  const open = 30_000 + 200 * Math.sin((index - 1) / 37) + 60 * Math.sin((index - 1) / 7.3);
  return {
    t: START + index * MIN,
    o: Number(open.toFixed(2)),
    h: Number((Math.max(open, close) + 15).toFixed(2)),
    l: Number((Math.min(open, close) - 15).toFixed(2)),
    c: Number(close.toFixed(2)),
    v: 10,
  };
}

const NEVER_ABORTS: AbortWatch = { reason: () => null, stop: () => undefined };

const inside = (ts: number) => EXPECTED.some((w) => w.from <= ts && ts <= w.to);

function requireRedisUrl(): string {
  const url = process.env.REDIS_URL;
  if (url === undefined || url === '') throw new Error('REDIS_URL no esta definida');
  return url;
}

describe('backtest con ventanas bloqueadas por eventos', () => {
  let db: ScratchDatabase;
  let runs: RunsRepository;
  let events: EventsRepository;
  let redis: Redis;
  const logger = createLogger({ role: 'worker', level: 'silent' });

  function deps(overrides: Partial<BacktestProcessorDeps> = {}): BacktestProcessorDeps {
    return {
      runs,
      candles: createCandlesRepository(db.pool),
      events,
      publisher: createRunEventPublisher({ redis }),
      logger,
      createWatch: () => NEVER_ABORTS,
      progressEveryBars: 5_000,
      progressMinIntervalMs: 0,
      ...overrides,
    };
  }

  function runInput(exec: ExecConfig): CreateRunInput {
    return {
      exchange: 'binance',
      symbol: SYMBOL,
      timeframe: TIMEFRAME,
      strategyId: 'ema-cross',
      params: PARAMS,
      exec,
      seed: 42,
      rangeFrom: START,
      rangeTo: START + BARS * MIN,
      engineVersion: '1.0.0',
      barsTotal: BARS,
    };
  }

  async function runToEnd(exec: ExecConfig, overrides: Partial<BacktestProcessorDeps> = {}) {
    const run = await runs.createRun(runInput(exec));
    await processBacktest(deps(overrides), { runId: run.id });
    const stored = await runs.getRun(run.id);
    const trades = await runs.getTrades(run.id, 10_000);
    return { stored, trades: trades.trades };
  }

  beforeAll(async () => {
    db = await createScratchDatabase({ applicationName: 'tt-itest-backtest-blocked' });
    await runMigrations({ pool: db.pool });
    runs = createRunsRepository(db.pool);
    events = createEventsRepository(db.pool);
    redis = new Redis(requireRedisUrl(), { maxRetriesPerRequest: null });

    await createCandlesRepository(db.pool).upsertCandles({
      exchange: 'binance',
      symbol: SYMBOL,
      timeframe: TIMEFRAME,
      source: 'rest',
      candles: Array.from({ length: BARS }, (_, index) => makeCandle(index)),
    });
    await events.upsertEvents(
      EVENTS.map((event, index) => ({
        source: event.type === 'eia-wpsr' ? 'eia' : 'fred',
        type: event.type,
        assetTags: ['macro'],
        scheduledAt: START + event.at * MIN,
        publishedAt: START + event.at * MIN,
        fetchedAt: event.fetchedAt,
        payload: { n: index },
      })),
    );
  });

  afterAll(async () => {
    redis.disconnect();
    await db.drop();
  });

  beforeEach(async () => {
    await db.pool.query('TRUNCATE backtest_runs CASCADE');
  });

  it('traduce la peticion a ventanas con fetched_at <= range_from, por tipo y fusionadas', async () => {
    const exec = await resolveBlockedWindows(events, {
      exec: EXEC,
      rangeFrom: START,
      rangeTo: START + BARS * MIN,
    });

    expect(exec.blockedWindows).toEqual(EXPECTED);
    expect(exec.eventBlackout).toEqual(EXEC.eventBlackout);
  });

  it('resolver dos veces da la misma lista: la resolucion es idempotente', async () => {
    const range = { rangeFrom: START, rangeTo: START + BARS * MIN };
    const once = await resolveBlockedWindows(events, { ...range, exec: EXEC });
    const twice = await resolveBlockedWindows(events, { ...range, exec: once });
    expect(twice.blockedWindows).toEqual(once.blockedWindows);
  });

  it('persiste las ventanas en exec_config y ninguna entrada cae dentro', async () => {
    const libre = await runToEnd({ ...EXEC, blockedWindows: undefined, eventBlackout: undefined });
    const { stored, trades } = await runToEnd(EXEC);

    expect(stored?.status).toBe('completed');
    expect(stored?.exec.blockedWindows).toEqual(EXPECTED);
    expect(stored?.exec.eventBlackout).toEqual(EXEC.eventBlackout);
    expect(libre.trades.some((trade) => inside(trade.entryTs))).toBe(true);
    expect(trades.length).toBeGreaterThan(0);
    expect(trades.some((trade) => inside(trade.entryTs))).toBe(false);
  });

  it('relanzar el run con su exec_config persistido da las mismas metricas', async () => {
    const first = await runToEnd(EXEC);
    const exec = first.stored?.exec;
    expect(exec).toBeDefined();
    if (exec === undefined) return;

    const again = await runToEnd(exec);
    const sinEventos = await runToEnd(exec, { events: undefined });

    expect(again.stored?.metrics).toEqual(first.stored?.metrics);
    expect(again.stored?.exec.blockedWindows).toEqual(EXPECTED);
    expect(sinEventos.stored?.status).toBe('failed');
  });

  it('sin acceso a market_events el run falla con un mensaje claro, no ignora el filtro', async () => {
    const { stored } = await runToEnd(EXEC, { events: undefined });
    expect(stored?.status).toBe('failed');
    expect(stored?.error).toContain('eventBlackout');
  });
});
