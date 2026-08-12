import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import {
  candlesResponseSchema,
  cancelBacktestResponseSchema,
  compareResponseSchema,
  coverageResponseSchema,
  createBacktestResponseSchema,
  equityResponseSchema,
  healthResponseSchema,
  listBacktestsResponseSchema,
  marketsResponseSchema,
  runDetailSchema,
  runEventSchema,
  strategyCatalogSchema,
  tradesResponseSchema,
  type Candle,
  type StrategyParam,
  type Timeframe,
} from '@tt/shared';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z, type ZodType } from 'zod';
import { runMigrations } from '../db/migrate.js';
import { createCandlesRepository, type CandlesRepository } from '../db/repositories/candles.repo.js';
import { createIngestStateRepository } from '../db/repositories/ingest-state.repo.js';
import {
  createRunsRepository,
  type CreateRunInput,
  type RunsRepository,
} from '../db/repositories/runs.repo.js';
import type { BacktestMetrics, EquityPoint, ExecConfig, Trade } from '../engine/types.js';
import { createLogger } from '../observability/logger.js';
import { createBacktestQueue, type BacktestQueue } from '../queue/backtest.queue.js';
import { createRedisCancelFlags } from '../queue/cancel-flags.js';
import { createQueueConnection } from '../queue/connection.js';
import { createScratchDatabase, type ScratchDatabase } from '../testing/scratch-db.js';
import { backtestsRouter } from './routes/backtests.js';
import { candlesRouter } from './routes/candles.js';
import { marketsRouter } from './routes/markets.js';
import { strategiesRouter } from './routes/strategies.js';
import { streamRouter } from './routes/stream.js';
import { createApiApp } from './server.js';
import { NO_CACHE } from './services/cache.js';
import { createSseHub } from './sse/hub.js';

const QUEUE_PREFIX = `tt-itest-contract-${randomUUID().slice(0, 8)}`;
const SYMBOL = 'CTRTEST';
const TIMEFRAME: Timeframe = '1h';
const STEP = 3_600_000;
const START = Date.UTC(2026, 0, 1);
const BARS = 300;
const NOW = START + BARS * STEP;

const EXEC: ExecConfig = {
  initialCapital: 10_000,
  riskPerTradePct: 1,
  feeBps: 6,
  slippageBps: 2,
  fillModel: 'next-open',
};

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
  barsTotal: BARS,
  openAtEnd: false,
};

const TRADES: Trade[] = [1, 2].map((seq) => ({
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
}));

const EQUITY: EquityPoint[] = [
  { t: START, equity: 10_000, drawdown: 0 },
  { t: START + STEP, equity: 10_500, drawdown: 0 },
];

function makeCandle(index: number): Candle {
  const base = 100 + (index % 40);
  return { t: START + index * STEP, o: base, h: base + 2, l: base - 2, c: base + 1, v: 10 };
}

function requireRedisUrl(): string {
  const url = process.env.REDIS_URL;
  if (url === undefined || url === '') {
    throw new Error('REDIS_URL no esta definida. Copia .env.example a .env y ejecuta npm run db:up.');
  }
  return url;
}

const errorDetailsSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.array(z.object({ path: z.string(), message: z.string() })),
  }),
});

function assertContract<T>(schema: ZodType<T>, body: unknown): T {
  const parsed = schema.parse(body);
  expect(parsed).toEqual(body);
  return parsed;
}

function defaultsOf(params: readonly StrategyParam[]): Record<string, unknown> {
  return Object.fromEntries(params.map((param) => [param.key, param.default]));
}

describe('contrato del API (docs/03)', () => {
  let db: ScratchDatabase;
  let candles: CandlesRepository;
  let runs: RunsRepository;
  let connection: Redis;
  let subscriber: Redis;
  let redis: Redis;
  let queue: BacktestQueue;
  let server: Server;
  let baseUrl: string;

  const logger = createLogger({ role: 'api', level: 'silent' });
  let app: ReturnType<typeof createApiApp>;

  beforeAll(async () => {
    db = await createScratchDatabase({ applicationName: 'tt-itest-contract' });
    await runMigrations({ pool: db.pool });
    candles = createCandlesRepository(db.pool);
    runs = createRunsRepository(db.pool);

    connection = createQueueConnection(requireRedisUrl());
    subscriber = new Redis(requireRedisUrl(), { maxRetriesPerRequest: null });
    redis = new Redis(requireRedisUrl(), { maxRetriesPerRequest: null });
    queue = createBacktestQueue(connection, { prefix: QUEUE_PREFIX });
    await queue.queue.obliterate({ force: true });

    await candles.upsertCandles({
      symbol: SYMBOL,
      timeframe: TIMEFRAME,
      source: 'rest',
      candles: Array.from({ length: BARS }, (_, index) => makeCandle(index)),
    });

    const marketDeps = {
      candles,
      ingestState: createIngestStateRepository(db.pool),
      cache: NO_CACHE,
      logger,
      exchange: 'bitget',
      symbols: [SYMBOL],
      timeframes: ['1m', '15m', '1h'] as Timeframe[],
      now: () => NOW,
    };

    app = createApiApp({
      logger,
      webOrigin: 'https://terminal.example',
      version: '0.1.0',
      uptimeSec: () => 1,
      checkDb: () => Promise.resolve(),
      checkRedis: () => Promise.resolve(),
      registerRoutes: (router) => {
        router.use(marketsRouter(marketDeps));
        router.use(candlesRouter({ ...marketDeps, symbols: [SYMBOL] }));
        router.use(strategiesRouter());
        router.use(
          backtestsRouter({
            runs,
            candles,
            queue,
            cancelFlags: createRedisCancelFlags(redis),
            logger,
            exchange: 'bitget',
            symbols: [SYMBOL],
            timeframes: ['1m', '15m', '1h'],
            maxBars: 500_000,
            generateSeed: () => 4_242,
          }),
        );
        router.use(
          streamRouter({
            runs,
            hub: createSseHub({ subscriber, logger }),
            logger,
            symbols: [SYMBOL],
            timeframes: ['1m', '15m', '1h'],
            sse: { heartbeatMs: 0 },
          }),
        );
      },
    });

    server = await new Promise<Server>((resolve, reject) => {
      const listening = app.listen(0, () => {
        resolve(listening);
      });
      listening.once('error', reject);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('el servidor no expuso un puerto');
    }
    baseUrl = `http://127.0.0.1:${address.port}/api`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    await queue.queue.obliterate({ force: true });
    await queue.close();
    connection.disconnect();
    subscriber.disconnect();
    redis.disconnect();
    await db.drop();
  });

  beforeEach(async () => {
    await db.pool.query('TRUNCATE backtest_runs CASCADE');
    await queue.queue.obliterate({ force: true });
  });

  function createBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      symbol: SYMBOL,
      timeframe: TIMEFRAME,
      from: new Date(START).toISOString(),
      to: new Date(START + 100 * STEP).toISOString(),
      strategyId: 'ema-cross',
      params: { fastPeriod: 12, slowPeriod: 26 },
      exec: EXEC,
      ...overrides,
    };
  }

  function runInput(overrides: Partial<CreateRunInput> = {}): CreateRunInput {
    return {
      exchange: 'bitget',
      symbol: SYMBOL,
      timeframe: TIMEFRAME,
      strategyId: 'ema-cross',
      params: { fastPeriod: 12, slowPeriod: 26 },
      exec: EXEC,
      seed: 42,
      rangeFrom: START,
      rangeTo: START + 100 * STEP,
      engineVersion: '1.0.0',
      barsTotal: BARS,
      ...overrides,
    };
  }

  async function completedRun(overrides: Partial<CreateRunInput> = {}): Promise<string> {
    const run = await runs.createRun(runInput(overrides));
    await runs.markRunning(run.id, BARS);
    await runs.completeRun({
      runId: run.id,
      metrics: METRICS,
      trades: TRADES,
      equity: EQUITY,
    });
    return run.id;
  }

  describe('cada endpoint documentado existe y valida contra su esquema de shared/', () => {
    it('GET /api/health', async () => {
      const response = await request(app).get('/api/health');

      expect(response.status).toBe(200);
      const body = assertContract(healthResponseSchema, response.body);
      expect(body.checks.db).toBe('ok');
    });

    it('GET /api/markets', async () => {
      const response = await request(app).get('/api/markets');

      expect(response.status).toBe(200);
      const body = assertContract(marketsResponseSchema, response.body);
      expect(body.symbols[0]?.symbol).toBe(SYMBOL);
    });

    it('GET /api/markets/:symbol/coverage', async () => {
      const response = await request(app).get(`/api/markets/${SYMBOL}/coverage?timeframe=1h`);

      expect(response.status).toBe(200);
      assertContract(coverageResponseSchema, response.body);
    });

    it('GET /api/candles', async () => {
      const response = await request(app).get(
        `/api/candles?symbol=${SYMBOL}&timeframe=1h&from=${START}&to=${START + 10 * STEP}`,
      );

      expect(response.status).toBe(200);
      const body = assertContract(candlesResponseSchema, response.body);
      expect(body.count).toBe(10);
    });

    it('GET /api/strategies', async () => {
      const response = await request(app).get('/api/strategies');

      expect(response.status).toBe(200);
      const body = assertContract(strategyCatalogSchema, response.body);
      expect(body.strategies.map((strategy) => strategy.id)).toEqual([
        'ema-cross',
        'range-breakout',
      ]);
    });

    it('POST /api/backtests', async () => {
      const response = await request(app).post('/api/backtests').send(createBody());

      expect(response.status).toBe(202);
      assertContract(createBacktestResponseSchema, response.body);
    });

    it('GET /api/backtests', async () => {
      await completedRun();
      const response = await request(app).get('/api/backtests?limit=10');

      expect(response.status).toBe(200);
      const body = assertContract(listBacktestsResponseSchema, response.body);
      expect(body.runs).toHaveLength(1);
    });

    it('GET /api/backtests/:id', async () => {
      const runId = await completedRun();
      const response = await request(app).get(`/api/backtests/${runId}`);

      expect(response.status).toBe(200);
      assertContract(runDetailSchema, response.body);
    });

    it('GET /api/backtests/:id/trades', async () => {
      const runId = await completedRun();
      const response = await request(app).get(`/api/backtests/${runId}/trades?limit=500`);

      expect(response.status).toBe(200);
      const body = assertContract(tradesResponseSchema, response.body);
      expect(body.trades).toHaveLength(2);
    });

    it('GET /api/backtests/:id/equity', async () => {
      const runId = await completedRun();
      const response = await request(app).get(`/api/backtests/${runId}/equity`);

      expect(response.status).toBe(200);
      const body = assertContract(equityResponseSchema, response.body);
      expect(body.points).toHaveLength(2);
    });

    it('GET /api/backtests/compare', async () => {
      const first = await completedRun();
      const second = await completedRun({ seed: 43 });
      const response = await request(app).get(`/api/backtests/compare?ids=${first},${second}`);

      expect(response.status).toBe(200);
      const body = assertContract(compareResponseSchema, response.body);
      expect(body.curves).toHaveLength(2);
    });

    it('POST /api/backtests/:id/cancel', async () => {
      const created = await request(app).post('/api/backtests').send(createBody());
      const response = await request(app).post(
        `/api/backtests/${created.body.runId}/cancel`,
      );

      expect(response.status).toBe(200);
      assertContract(cancelBacktestResponseSchema, response.body);
    });

    it('DELETE /api/backtests/:id devuelve 204 sin cuerpo', async () => {
      const runId = await completedRun();
      const response = await request(app).delete(`/api/backtests/${runId}`);

      expect(response.status).toBe(204);
      expect(response.text).toBe('');
    });

    it('GET /api/backtests/:id/stream emite eventos que validan contra runEventSchema', async () => {
      const runId = await completedRun();

      const response = await fetch(`${baseUrl}/backtests/${runId}/stream`);
      expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
      const text = await response.text();

      const frames = text
        .split('\n\n')
        .filter((frame) => frame.includes('data: '))
        .map((frame) => {
          const event = /event: (.+)/.exec(frame)?.[1] ?? '';
          const data: unknown = JSON.parse(/data: (.+)/.exec(frame)?.[1] ?? 'null');
          return { event, data };
        });

      expect(frames.map((frame) => frame.event)).toEqual(['status', 'done']);
      for (const frame of frames) {
        expect(() =>
          runEventSchema.parse({ ...(frame.data as object), type: frame.event }),
        ).not.toThrow();
      }
    });

    it('GET /api/stream/candles responde con el content-type de SSE', async () => {
      const controller = new AbortController();
      const response = await fetch(
        `${baseUrl}/stream/candles?symbol=${SYMBOL}&timeframe=1h`,
        { signal: controller.signal },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
      controller.abort();
    });

    it('los errores usan el sobre documentado en docs/03 §Errores', async () => {
      const response = await request(app).get(`/api/backtests/${randomUUID()}`);

      expect(response.status).toBe(404);
      expect(Object.keys(response.body)).toEqual(['error']);
      expect(response.body.error.code).toBe('NOT_FOUND');
      expect(typeof response.body.error.message).toBe('string');
    });
  });

  describe('el catalogo permite reconstruir un formulario valido', () => {
    it('los defaults de cada estrategia bastan para lanzar un backtest', async () => {
      const catalog = strategyCatalogSchema.parse(
        (await request(app).get('/api/strategies')).body,
      );

      for (const strategy of catalog.strategies) {
        const response = await request(app)
          .post('/api/backtests')
          .send(createBody({ strategyId: strategy.id, params: defaultsOf(strategy.params) }));

        expect(response.status, `estrategia ${strategy.id}`).toBe(202);
      }
    });

    it('los defaults del catalogo son los que aplica el API si no se manda nada', async () => {
      const catalog = strategyCatalogSchema.parse(
        (await request(app).get('/api/strategies')).body,
      );

      for (const strategy of catalog.strategies) {
        const explicit = await request(app)
          .post('/api/backtests')
          .send(
            createBody({
              strategyId: strategy.id,
              params: defaultsOf(strategy.params),
              seed: 1,
            }),
          );
        const implicit = await request(app)
          .post('/api/backtests')
          .send(createBody({ strategyId: strategy.id, params: {}, seed: 1 }));

        expect(implicit.body.paramsHash, `estrategia ${strategy.id}`).toBe(
          explicit.body.paramsHash,
        );
      }
    });

    it('los limites del catalogo son los que valida el API', async () => {
      const catalog = strategyCatalogSchema.parse(
        (await request(app).get('/api/strategies')).body,
      );

      for (const strategy of catalog.strategies) {
        const bounded = strategy.params.find(
          (param) => param.min !== undefined && param.type !== 'bool',
        );
        if (bounded?.min === undefined) {
          continue;
        }

        const response = await request(app)
          .post('/api/backtests')
          .send(
            createBody({
              strategyId: strategy.id,
              params: { ...defaultsOf(strategy.params), [bounded.key]: bounded.min - 1 },
            }),
          );

        expect(response.status, `estrategia ${strategy.id}`).toBe(400);
        const details = errorDetailsSchema.parse(response.body);
        expect(
          details.error.details.some((detail) => detail.path === `body.params.${bounded.key}`),
          `estrategia ${strategy.id}, parametro ${bounded.key}`,
        ).toBe(true);
      }
    });

    it('cada parametro declara tipo y default utilizables por un formulario', async () => {
      const catalog = strategyCatalogSchema.parse(
        (await request(app).get('/api/strategies')).body,
      );

      expect(catalog.strategies.length).toBeGreaterThan(0);
      for (const strategy of catalog.strategies) {
        expect(strategy.params.length).toBeGreaterThan(0);
        for (const param of strategy.params) {
          if (param.type === 'bool') {
            expect(typeof param.default).toBe('boolean');
          } else if (param.type === 'enum') {
            expect(typeof param.default).toBe('string');
            expect(param.options).toBeDefined();
            expect(param.options).toContain(param.default);
          } else {
            expect(typeof param.default).toBe('number');
            expect(param.min).toBeDefined();
            expect(param.max).toBeDefined();
          }
        }
      }
    });
  });
});
