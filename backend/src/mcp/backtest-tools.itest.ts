import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  MCP_SAMPLE_POINTS,
  MCP_SAMPLE_TRADES,
  createBacktestBodySchema,
  runBacktestShape,
  type Candle,
} from '@tt/shared';
import type { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { backtestsRouter } from '../api/routes/backtests.js';
import { strategiesRouter } from '../api/routes/strategies.js';
import { createApiApp } from '../api/server.js';
import type { BacktestsServiceDeps } from '../api/services/backtests.service.js';
import { runMigrations } from '../db/migrate.js';
import type { CreateRunInput } from '../db/repositories/runs.repo.js';
import type { BacktestMetrics, EquityPoint, Trade } from '../engine/types.js';
import { createCandlesRepository } from '../db/repositories/candles.repo.js';
import { createRunsRepository } from '../db/repositories/runs.repo.js';
import { createLogger } from '../observability/logger.js';
import { createBacktestQueue, type BacktestQueue } from '../queue/backtest.queue.js';
import { createRedisCancelFlags } from '../queue/cancel-flags.js';
import { createQueueConnection } from '../queue/connection.js';
import { buildMcpDeps } from '../roles/mcp.js';
import { createScratchDatabase, type ScratchDatabase } from '../testing/scratch-db.js';
import { buildMcpServer } from './server.js';
import { createRunRateLimiter } from './tools/run-backtest.js';

const QUEUE_PREFIX = `tt-itest-mcp-bt-${randomUUID().slice(0, 8)}`;
const SYMBOL = 'MCPBTUSDT';
const STEP = 3_600_000;
const START = Date.UTC(2026, 0, 1);
const MAX_BARS = 1_000;
const GENERATED_SEED = 7_777;
const TRADES = 45;
const EQUITY_POINTS = 600;

const METRICS: BacktestMetrics = {
  netProfit: 1843.21,
  netProfitPct: 18.43,
  maxDrawdown: 0.121,
  maxDrawdownQuote: 1204.55,
  winRate: 0.5,
  profitFactor: 1.61,
  expectancyR: 0.23,
  trades: TRADES,
  wins: 23,
  losses: 22,
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

function equityPoint(index: number): EquityPoint {
  return { t: START + index * 60_000, equity: 10_000 + index, drawdown: 0 };
}

function makeCandle(index: number): Candle {
  const base = 100 + index;
  return { t: START + index * STEP, o: base, h: base + 1, l: base - 1, c: base + 0.5, v: 10 };
}

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    exchange: 'binance',
    symbol: SYMBOL,
    timeframe: '1h',
    from: START,
    to: START + 100 * STEP,
    strategyId: 'ema-cross',
    params: { fastPeriod: 12, slowPeriod: 26 },
    exec: {
      initialCapital: 10_000,
      riskPerTradePct: 1,
      feeBps: 6,
      slippageBps: 2,
      fillModel: 'next-open',
    },
    ...overrides,
  };
}

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' ? Reflect.get(value, key) : undefined;
}

function textOf(result: unknown): string {
  const content = field(result, 'content');
  const text = field(Array.isArray(content) ? content[0] : undefined, 'text');
  return typeof text === 'string' ? text : '';
}

function isError(result: unknown): boolean {
  return field(result, 'isError') === true;
}

function requireRedisUrl(): string {
  const url = process.env.REDIS_URL;
  if (url === undefined || url === '') throw new Error('REDIS_URL no esta definida');
  return url;
}

describe('MCP server: tools de backtesting', () => {
  let db: ScratchDatabase;
  let connection: Redis;
  let queue: BacktestQueue;
  let service: BacktestsServiceDeps;
  let client: Client;
  let app: ReturnType<typeof createApiApp>;

  function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return client.callTool({ name, arguments: args });
  }

  beforeAll(async () => {
    db = await createScratchDatabase({ applicationName: 'tt-itest-mcp-backtests' });
    await runMigrations({ pool: db.pool });
    connection = createQueueConnection(requireRedisUrl());
    queue = createBacktestQueue(connection, { prefix: QUEUE_PREFIX });
    await queue.queue.obliterate({ force: true });

    const logger = createLogger({ role: 'mcp', level: 'silent' });
    service = {
      runs: createRunsRepository(db.pool),
      candles: createCandlesRepository(db.pool),
      queue,
      cancelFlags: createRedisCancelFlags(connection),
      logger,
      markets: { exchanges: [{ exchange: 'binance', symbols: [SYMBOL] }] },
      timeframes: ['1m', '15m', '1h'],
      maxBars: MAX_BARS,
      generateSeed: () => GENERATED_SEED,
    };

    app = createApiApp({
      logger,
      webOrigin: 'https://terminal.example',
      version: '0.1.0',
      uptimeSec: () => 1,
      checkDb: () => Promise.resolve(),
      checkRedis: () => Promise.resolve(),
      registerRoutes: (router) => {
        router.use(strategiesRouter());
        router.use(backtestsRouter(service));
      },
    });

    const server = buildMcpServer({
      ...buildMcpDeps({ pool: db.pool, logger, closePool: false }),
      backtests: { service, takeSlot: createRunRateLimiter({ max: 1_000 }, () => Date.now()) },
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    client = new Client({ name: 'itest', version: '0.0.0' });
    await client.connect(clientSide);
  });

  afterAll(async () => {
    await client.close();
    await queue.queue.obliterate({ force: true });
    await queue.close();
    connection.disconnect();
    await db.drop();
  });

  beforeEach(async () => {
    await queue.queue.obliterate({ force: true });
    await db.pool.query('TRUNCATE backtest_runs CASCADE');
    await db.pool.query('TRUNCATE candles');
    await service.candles.upsertCandles({
      exchange: 'binance',
      symbol: SYMBOL,
      timeframe: '1h',
      source: 'rest',
      candles: Array.from({ length: 200 }, (_, index) => makeCandle(index)),
    });
  });

  it('list_strategies devuelve el mismo catalogo que GET /api/strategies', async () => {
    const result = await callTool('list_strategies', {});
    const api = await request(app).get('/api/strategies').expect(200);

    expect(isError(result)).toBe(false);
    expect(JSON.parse(textOf(result))).toEqual(api.body);
    expect(textOf(result)).toContain('ema-cross');
    expect(textOf(result)).toContain('"default"');
  });

  it('run_backtest encola y devuelve runId, el seed generado y paramsHash', async () => {
    const result = await callTool('run_backtest', body());
    expect(isError(result)).toBe(false);
    const payload: unknown = JSON.parse(textOf(result));

    expect(payload).toMatchObject({ status: 'queued', seed: GENERATED_SEED, barsTotal: 100 });
    expect(field(payload, 'paramsHash')).toEqual(expect.any(String));
    expect(await queue.queue.getJob(String(field(payload, 'runId')))).toBeDefined();
  });

  it('un run de la tool es indistinguible en BD de uno del API con la misma config', async () => {
    const config = body({ seed: 123, label: 'gemelo' });
    const api = await request(app).post('/api/backtests').send(config).expect(202);
    const tool: unknown = JSON.parse(textOf(await callTool('run_backtest', config)));

    const { rows } = await db.pool.query<Record<string, unknown>>(
      `SELECT * FROM backtest_runs WHERE id = ANY($1::uuid[]) ORDER BY created_at`,
      [[field(api.body, 'runId'), field(tool, 'runId')]],
    );
    expect(rows).toHaveLength(2);
    const strip = (row: Record<string, unknown> | undefined) => {
      const { id: _id, created_at: _createdAt, ...rest } = row ?? {};
      return rest;
    };
    expect(strip(rows[1])).toEqual(strip(rows[0]));
    expect(field(tool, 'paramsHash')).toBe(field(api.body, 'paramsHash'));
    expect(field(tool, 'seed')).toBe(123);
  });

  it('params invalidos: el mismo error, con el path del campo, que el 400 del API', async () => {
    const invalid = body({ params: { fastPeriod: -3, slowPeriod: 'x' } });
    const api = await request(app).post('/api/backtests').send(invalid).expect(400);
    const result = await callTool('run_backtest', invalid);

    expect(isError(result)).toBe(true);
    expect(JSON.parse(textOf(result))).toEqual(api.body);
    expect(JSON.stringify(api.body)).toContain('body.params.fastPeriod');
  });

  it('cuerpo invalido: el SDK lo rechaza con el mismo esquema, el campo y el mensaje de Zod', async () => {
    const invalid = body({ timeframe: '2h' });
    const api = await request(app).post('/api/backtests').send(invalid).expect(400);
    const result = await callTool('run_backtest', invalid);
    const detail = field(field(field(api.body, 'error'), 'details'), '0');

    expect(isError(result)).toBe(true);
    expect(field(detail, 'path')).toBe('body.timeframe');
    expect(textOf(result)).toContain('timeframe');
    expect(textOf(result)).toContain(String(field(detail, 'message')));
  });

  it('un rango por encima de BACKTEST_MAX_BARS da el mismo error que el 413 y no crea run', async () => {
    const huge = body({ to: START + (MAX_BARS + 1) * STEP });
    const api = await request(app).post('/api/backtests').send(huge).expect(413);
    const result = await callTool('run_backtest', huge);

    expect(isError(result)).toBe(true);
    expect(JSON.parse(textOf(result))).toEqual(api.body);
    expect(field(field(api.body, 'error'), 'code')).toBe('RANGE_TOO_LARGE');
    const { rows } = await db.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM backtest_runs',
    );
    expect(rows[0]?.n).toBe(0);
  });

  it('la tool publica el esquema del body del API, el mismo objeto y no una copia', async () => {
    expect(runBacktestShape).toBe(createBacktestBodySchema.shape);
    const { tools } = await client.listTools();
    const tool = tools.find((item) => item.name === 'run_backtest');
    expect(tool?.inputSchema.required).toEqual(
      expect.arrayContaining(['exchange', 'symbol', 'timeframe', 'from', 'to', 'strategyId']),
    );
  });

  function runInput(overrides: Partial<CreateRunInput> = {}): CreateRunInput {
    return {
      exchange: 'binance',
      symbol: SYMBOL,
      timeframe: '1h',
      strategyId: 'ema-cross',
      params: { fastPeriod: 12, slowPeriod: 26 },
      exec: {
        initialCapital: 10_000,
        riskPerTradePct: 1,
        feeBps: 6,
        slippageBps: 2,
        fillModel: 'next-open',
      },
      seed: 7,
      rangeFrom: START,
      rangeTo: START + 100 * STEP,
      engineVersion: '1.0.0',
      barsTotal: 100,
      ...overrides,
    };
  }

  async function completedRun(overrides: Partial<CreateRunInput> = {}): Promise<string> {
    const run = await service.runs.createRun(runInput(overrides));
    await service.runs.markRunning(run.id, 100);
    await service.runs.completeRun({
      runId: run.id,
      metrics: METRICS,
      trades: Array.from({ length: TRADES }, (_, i) => trade(i + 1)),
      equity: Array.from({ length: EQUITY_POINTS }, (_, i) => equityPoint(i)),
    });
    return run.id;
  }

  async function metricsOf(runId: string): Promise<{ error: boolean; data: unknown }> {
    const result = await callTool('get_run_metrics', { runId });
    return { error: isError(result), data: JSON.parse(textOf(result)) };
  }

  describe('get_run_metrics', () => {
    it('un run en cola o en curso devuelve su estado y progreso, no un error', async () => {
      const queued = await service.runs.createRun(runInput());
      const q = await metricsOf(queued.id);
      expect(q.error).toBe(false);
      expect(q.data).toMatchObject({ run: { status: 'queued', metrics: null }, trades: null });

      await service.runs.markRunning(queued.id, 100);
      await service.runs.updateProgress(queued.id, 40);
      const r = await metricsOf(queued.id);
      expect(r.error).toBe(false);
      expect(r.data).toMatchObject({
        run: { status: 'running', progress: { barsDone: 40, barsTotal: 100 } },
        equity: null,
      });
    });

    it('un run fallido devuelve su error, sin stack trace', async () => {
      const run = await service.runs.createRun(runInput());
      await service.runs.markRunning(run.id, 100);
      await service.runs.failRun(run.id, 'No hay velas en el rango pedido');

      const { error, data } = await metricsOf(run.id);
      expect(error).toBe(false);
      expect(data).toMatchObject({
        run: { status: 'failed', error: 'No hay velas en el rango pedido' },
      });
      expect(JSON.stringify(data)).not.toMatch(/\bat \S+:\d+/u);
      expect(JSON.stringify(data)).not.toContain('stack');
    });

    it('un run cancelado lo dice', async () => {
      const run = await service.runs.createRun(runInput());
      await service.runs.cancelRun(run.id);
      expect((await metricsOf(run.id)).data).toMatchObject({ run: { status: 'cancelled' } });
    });

    it('un run completado trae metricas y trades y curva recortados, con el total real', async () => {
      const runId = await completedRun();
      const { error, data } = await metricsOf(runId);
      const api = await request(app).get(`/api/backtests/${runId}`).expect(200);

      expect(error).toBe(false);
      expect(field(data, 'run')).toEqual(api.body);
      const trades = field(data, 'trades');
      const equity = field(data, 'equity');
      expect(field(trades, 'total')).toBe(TRADES);
      expect(field(trades, 'sample')).toHaveLength(MCP_SAMPLE_TRADES);
      expect(field(equity, 'total')).toBe(EQUITY_POINTS);
      const sample = field(equity, 'sample');
      expect(Array.isArray(sample) && sample.length).toBeLessThanOrEqual(MCP_SAMPLE_POINTS);
      expect(Array.isArray(sample) && sample.length).toBeGreaterThan(MCP_SAMPLE_POINTS / 2);
    });

    it('un runId inexistente da un error limpio NOT_FOUND', async () => {
      const result = await callTool('get_run_metrics', { runId: randomUUID() });
      expect(isError(result)).toBe(true);
      expect(field(field(JSON.parse(textOf(result)), 'error'), 'code')).toBe('NOT_FOUND');
    });

    it('un runId que no es uuid da error de input', async () => {
      const result = await callTool('get_run_metrics', { runId: 'nope' });
      expect(isError(result)).toBe(true);
      expect(textOf(result)).toContain('runId');
    });
  });

  describe('compare_runs', () => {
    it('devuelve lo mismo que el comparador del API, con las curvas recortadas', async () => {
      const a = await completedRun();
      const b = await completedRun({ seed: 8 });
      const result = await callTool('compare_runs', { runIds: [a, b] });
      const api = await request(app).get(`/api/backtests/compare?ids=${a},${b}`).expect(200);
      const data: unknown = JSON.parse(textOf(result));

      expect(isError(result)).toBe(false);
      expect(field(data, 'runs')).toEqual(api.body.runs);
      expect(field(data, 'warnings')).toEqual([]);
      const curves = field(data, 'curves');
      const first = Array.isArray(curves) ? curves[0] : undefined;
      expect(field(first, 'total')).toBe(api.body.curves[0].points.length);
      expect(field(first, 'sample')).toHaveLength(MCP_SAMPLE_POINTS);
    });

    it('avisa de engine_version distinto', async () => {
      const a = await completedRun();
      const b = await completedRun({ engineVersion: '2.0.0' });
      const data: unknown = JSON.parse(textOf(await callTool('compare_runs', { runIds: [a, b] })));
      expect(field(data, 'warnings')).toEqual(['engine-version-mismatch']);
    });

    it('avisa de exchanges distintos', async () => {
      const a = await completedRun();
      const b = await completedRun({ exchange: 'hyperliquid' });
      const data: unknown = JSON.parse(textOf(await callTool('compare_runs', { runIds: [a, b] })));
      expect(field(data, 'warnings')).toEqual(['exchange-mismatch']);
    });

    it('un runId inexistente da un error limpio NOT_FOUND', async () => {
      const a = await completedRun();
      const result = await callTool('compare_runs', { runIds: [a, randomUUID()] });
      expect(isError(result)).toBe(true);
      expect(field(field(JSON.parse(textOf(result)), 'error'), 'code')).toBe('NOT_FOUND');
    });
  });
});
