import type { Server } from 'node:http';
import { runChannel, type Timeframe } from '@tt/shared';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runMigrations } from '../../db/migrate.js';
import {
  createRunsRepository,
  type CreateRunInput,
  type RunsRepository,
} from '../../db/repositories/runs.repo.js';
import type { BacktestMetrics, ExecConfig } from '../../engine/types.js';
import { createLogger } from '../../observability/logger.js';
import { candleChannel } from '../../queue/pubsub.js';
import { createScratchDatabase, type ScratchDatabase } from '../../testing/scratch-db.js';
import { streamRouter } from '../routes/stream.js';
import { createApiApp } from '../server.js';
import { createSseHub, type SseHub, type SubscriberLike } from './hub.js';

const SYMBOL = 'SSETEST';
const TIMEFRAME: Timeframe = '1m';
const START = Date.UTC(2026, 0, 1);

const EXEC: ExecConfig = {
  initialCapital: 10_000,
  riskPerTradePct: 1,
  feeBps: 6,
  slippageBps: 2,
  fillModel: 'next-open',
};

const METRICS: BacktestMetrics = {
  netProfit: 100,
  netProfitPct: 1,
  maxDrawdown: 0.01,
  maxDrawdownQuote: 100,
  winRate: 1,
  profitFactor: null,
  expectancyR: 1,
  trades: 1,
  wins: 1,
  losses: 0,
  avgWinR: 1,
  avgLossR: null,
  largestWinR: 1,
  largestLossR: null,
  exposurePct: 10,
  barsTotal: 100,
  openAtEnd: false,
};

const errorEnvelopeSchema = z.object({ error: z.object({ code: z.string() }) });

function requireRedisUrl(): string {
  const url = process.env.REDIS_URL;
  if (url === undefined || url === '') {
    throw new Error('REDIS_URL no esta definida. Copia .env.example a .env y ejecuta npm run db:up.');
  }
  return url;
}

interface SseFrame {
  readonly event: string;
  readonly data: unknown;
}

interface SseClient {
  readonly frames: SseFrame[];
  readonly comments: string[];
  readonly headers: Headers;
  readonly ended: boolean;
  waitForFrame(event: string, timeoutMs?: number): Promise<SseFrame>;
  waitForEnd(timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`se agoto el tiempo esperando ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function connect(url: string): Promise<SseClient> {
  const controller = new AbortController();
  const response = await fetch(url, {
    signal: controller.signal,
    headers: { Accept: 'text/event-stream' },
  });

  const body = response.body;
  if (body === null) {
    throw new Error('la respuesta sse no trae cuerpo');
  }

  const frames: SseFrame[] = [];
  const comments: string[] = [];
  let ended = false;
  let buffer = '';

  const pump = (async (): Promise<void> => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut = buffer.indexOf('\n\n');
      while (cut >= 0) {
        const raw = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        let event = 'message';
        let data = '';
        for (const line of raw.split('\n')) {
          if (line.startsWith(':')) comments.push(line.slice(1).trim());
          else if (line.startsWith('event: ')) event = line.slice(7);
          else if (line.startsWith('data: ')) data = line.slice(6);
        }
        if (data !== '') frames.push({ event, data: JSON.parse(data) });
        cut = buffer.indexOf('\n\n');
      }
    }
  })()
    .catch(() => undefined)
    .finally(() => {
      ended = true;
    });

  return {
    frames,
    comments,
    headers: response.headers,
    get ended(): boolean {
      return ended;
    },
    async waitForFrame(event: string, timeoutMs = 5_000): Promise<SseFrame> {
      await waitUntil(
        () => frames.some((frame) => frame.event === event),
        timeoutMs,
        `el evento ${event}`,
      );
      const found = frames.find((frame) => frame.event === event);
      if (found === undefined) throw new Error(`no llego el evento ${event}`);
      return found;
    },
    async waitForEnd(timeoutMs = 5_000): Promise<void> {
      await waitUntil(() => ended, timeoutMs, 'el cierre del stream');
    },
    async close(): Promise<void> {
      controller.abort();
      await pump;
    },
  };
}

describe('sse', () => {
  let db: ScratchDatabase;
  let runs: RunsRepository;
  let subscriber: Redis;
  let publisher: Redis;
  let hub: SseHub;
  let server: Server;
  let baseUrl: string;
  let subscribes: string[];
  let unsubscribes: string[];

  const logger = createLogger({ role: 'api', level: 'silent' });
  const clients: SseClient[] = [];

  beforeAll(async () => {
    db = await createScratchDatabase({ applicationName: 'tt-itest-sse' });
    await runMigrations({ pool: db.pool });
    runs = createRunsRepository(db.pool);

    subscriber = new Redis(requireRedisUrl(), { maxRetriesPerRequest: null });
    publisher = new Redis(requireRedisUrl(), { maxRetriesPerRequest: null });
    subscribes = [];
    unsubscribes = [];

    const counting: SubscriberLike = {
      subscribe: (channel: string) => {
        subscribes.push(channel);
        return subscriber.subscribe(channel);
      },
      unsubscribe: (channel: string) => {
        unsubscribes.push(channel);
        return subscriber.unsubscribe(channel);
      },
      on: (event: 'message', listener: (channel: string, message: string) => void) =>
        subscriber.on(event, listener),
    };

    hub = createSseHub({ subscriber: counting, logger });

    const app = createApiApp({
      logger,
      webOrigin: 'https://terminal.example',
      version: '0.1.0',
      uptimeSec: () => 1,
      checkDb: () => Promise.resolve(),
      checkRedis: () => Promise.resolve(),
      registerRoutes: (router) => {
        router.use(
          streamRouter({
            runs,
            hub,
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

  afterEach(async () => {
    while (clients.length > 0) {
      await clients.pop()?.close();
    }
    await waitUntil(() => hub.channels().length === 0, 5_000, 'la liberacion de los canales');
    subscribes.length = 0;
    unsubscribes.length = 0;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    subscriber.disconnect();
    publisher.disconnect();
    await db.drop();
  });

  beforeEach(async () => {
    await db.pool.query('TRUNCATE backtest_runs CASCADE');
  });

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
      rangeTo: START + 100 * 60_000,
      engineVersion: '1.0.0',
      barsTotal: 100,
      ...overrides,
    };
  }

  async function open(path: string): Promise<SseClient> {
    const client = await connect(`${baseUrl}${path}`);
    clients.push(client);
    return client;
  }

  async function openRunStream(runId: string): Promise<SseClient> {
    const client = await open(`/backtests/${runId}/stream`);
    await client.waitForFrame('status');
    await waitUntil(
      () => hub.listenerCount(runChannel(runId)) > 0,
      5_000,
      'la suscripcion al canal del run',
    );
    return client;
  }

  function publish(channel: string, payload: unknown): Promise<unknown> {
    return publisher.publish(channel, JSON.stringify(payload));
  }

  describe('GET /api/backtests/:id/stream', () => {
    it('sirve el stream con las cabeceras del contrato', async () => {
      const run = await runs.createRun(runInput());
      const client = await openRunStream(run.id);

      expect(client.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
      expect(client.headers.get('cache-control')).toBe('no-cache, no-transform');
      expect(client.headers.get('x-accel-buffering')).toBe('no');
      expect(client.headers.get('content-encoding')).toBeNull();
    });

    it('entrega status, progress y done en orden y cierra al terminar', async () => {
      const run = await runs.createRun(runInput());
      const client = await openRunStream(run.id);

      expect(client.frames[0]).toEqual({
        event: 'status',
        data: { runId: run.id, status: 'queued', barsTotal: 100 },
      });

      await publish(runChannel(run.id), {
        type: 'status',
        runId: run.id,
        status: 'running',
        barsTotal: 100,
      });
      await publish(runChannel(run.id), {
        type: 'progress',
        runId: run.id,
        pct: 34.2,
        barsDone: 34,
        trades: 2,
        equity: '10480.2',
        etaMs: 2600,
      });
      await publish(runChannel(run.id), {
        type: 'progress',
        runId: run.id,
        pct: 100,
        barsDone: 100,
        trades: 5,
        equity: '10900',
        etaMs: 0,
      });
      await publish(runChannel(run.id), { type: 'done', runId: run.id, status: 'completed' });

      await client.waitForEnd();

      expect(client.frames.map((frame) => frame.event)).toEqual([
        'status',
        'status',
        'progress',
        'progress',
        'done',
      ]);
      expect(client.frames[2]?.data).toMatchObject({ pct: 34.2, barsDone: 34, equity: '10480.2' });
      expect(client.frames[4]?.data).toEqual({ runId: run.id, status: 'completed' });
    });

    it('un run ya terminado recibe status y done inmediatos y el stream se cierra', async () => {
      const run = await runs.createRun(runInput());
      await runs.markRunning(run.id, 100);
      await runs.completeRun({ runId: run.id, metrics: METRICS, trades: [], equity: [] });

      const client = await open(`/backtests/${run.id}/stream`);
      await client.waitForEnd();

      expect(client.frames).toEqual([
        { event: 'status', data: { runId: run.id, status: 'completed', barsTotal: 100 } },
        { event: 'done', data: { runId: run.id, status: 'completed' } },
      ]);
      expect(hub.channels()).toEqual([]);
      expect(subscribes).toEqual([]);
    });

    it('reemite el evento error del worker', async () => {
      const run = await runs.createRun(runInput());
      const client = await openRunStream(run.id);

      await publish(runChannel(run.id), {
        type: 'error',
        runId: run.id,
        code: 'INTERNAL',
        message: 'la estrategia reventó',
      });

      const frame = await client.waitForFrame('error');
      expect(frame.data).toMatchObject({ code: 'INTERNAL', message: 'la estrategia reventó' });
    });

    it('un mensaje ilegible se descarta sin cerrar el stream', async () => {
      const run = await runs.createRun(runInput());
      const client = await openRunStream(run.id);

      await publisher.publish(runChannel(run.id), 'esto no es json');
      await publish(runChannel(run.id), { type: 'inventado', runId: run.id });
      await publish(runChannel(run.id), {
        type: 'progress',
        runId: run.id,
        pct: 10,
        barsDone: 10,
        trades: 0,
        equity: '10000',
        etaMs: null,
      });

      const frame = await client.waitForFrame('progress');
      expect(frame.data).toMatchObject({ pct: 10 });
      expect(client.ended).toBe(false);
    });

    it('el cliente que se va libera la suscripcion y la conexion Redis se reutiliza', async () => {
      const run = await runs.createRun(runInput());
      const client = await openRunStream(run.id);
      const channel = runChannel(run.id);

      expect(hub.listenerCount(channel)).toBe(1);
      expect(subscribes).toEqual([channel]);

      await client.close();
      clients.length = 0;

      await waitUntil(() => hub.listenerCount(channel) === 0, 5_000, 'la liberacion del canal');
      expect(hub.channels()).toEqual([]);
      expect(unsubscribes).toEqual([channel]);

      const second = await openRunStream(run.id);
      expect(subscribes).toEqual([channel, channel]);
      expect(second.frames[0]?.event).toBe('status');
    });

    it('50 clientes sobre el mismo run comparten una unica suscripcion Redis', async () => {
      const run = await runs.createRun(runInput());
      const channel = runChannel(run.id);

      const opened = await Promise.all(
        Array.from({ length: 50 }, () => open(`/backtests/${run.id}/stream`)),
      );
      await waitUntil(() => hub.listenerCount(channel) === 50, 10_000, 'los 50 clientes');

      expect(subscribes).toEqual([channel]);
      expect(hub.channels()).toEqual([channel]);

      await publish(channel, {
        type: 'progress',
        runId: run.id,
        pct: 50,
        barsDone: 50,
        trades: 1,
        equity: '10100',
        etaMs: 100,
      });

      for (const client of opened) {
        const frame = await client.waitForFrame('progress');
        expect(frame.data).toMatchObject({ pct: 50 });
      }
      expect(unsubscribes).toEqual([]);
    });

    it('un run inexistente responde 404 con el sobre de error, no un stream', async () => {
      const response = await fetch(
        `${baseUrl}/backtests/1c8f2a4e-0000-4000-8000-000000000000/stream`,
      );

      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toContain('application/json');
      const body = errorEnvelopeSchema.parse(await response.json());
      expect(body.error.code).toBe('NOT_FOUND');
    });

    it('un id que no es uuid responde 400', async () => {
      const response = await fetch(`${baseUrl}/backtests/no-soy-uuid/stream`);
      expect(response.status).toBe(400);
      await response.body?.cancel();
    });
  });

  describe('GET /api/stream/candles', () => {
    it('reemite los ticks del canal de velas con el formato del contrato', async () => {
      const client = await open(`/stream/candles?symbol=${SYMBOL}&timeframe=1m`);
      const channel = candleChannel(SYMBOL, TIMEFRAME);
      await waitUntil(() => hub.listenerCount(channel) === 1, 5_000, 'la suscripcion a velas');

      await publish(channel, {
        t: START,
        o: 100,
        h: 101,
        l: 99,
        c: 100.5,
        v: 12.4,
        closed: false,
      });
      await publish(channel, {
        t: START,
        o: 100,
        h: 102,
        l: 99,
        c: 101.5,
        v: 15,
        closed: true,
      });

      await waitUntil(() => client.frames.length === 2, 5_000, 'los dos ticks');
      expect(client.frames[0]).toEqual({
        event: 'candle',
        data: { t: START, o: 100, h: 101, l: 99, c: 100.5, v: 12.4, closed: false },
      });
      expect(client.frames[1]?.data).toMatchObject({ closed: true, c: 101.5 });
    });

    it('un tick incoherente se descarta y el stream sigue vivo', async () => {
      const client = await open(`/stream/candles?symbol=${SYMBOL}&timeframe=1m`);
      const channel = candleChannel(SYMBOL, TIMEFRAME);
      await waitUntil(() => hub.listenerCount(channel) === 1, 5_000, 'la suscripcion a velas');

      await publish(channel, { t: START, o: 100, h: 90, l: 99, c: 100, v: 1, closed: true });
      await publish(channel, { t: START, o: 100, h: 101, l: 99, c: 100, v: 1, closed: true });

      await waitUntil(() => client.frames.length === 1, 5_000, 'el tick valido');
      expect(client.frames[0]?.data).toMatchObject({ h: 101 });
      expect(client.ended).toBe(false);
    });

    it('dos timeframes del mismo simbolo son dos canales distintos', async () => {
      await open(`/stream/candles?symbol=${SYMBOL}&timeframe=1m`);
      await open(`/stream/candles?symbol=${SYMBOL}&timeframe=1h`);

      await waitUntil(() => hub.channels().length === 2, 5_000, 'los dos canales');
      expect([...hub.channels()].sort()).toEqual(
        [candleChannel(SYMBOL, '1m'), candleChannel(SYMBOL, '1h')].sort(),
      );
    });

    it('un simbolo no servido responde 404', async () => {
      const response = await fetch(`${baseUrl}/stream/candles?symbol=NOPEUSDT&timeframe=1m`);
      expect(response.status).toBe(404);
      await response.body?.cancel();
    });

    it('un timeframe fuera del contrato responde 400', async () => {
      const response = await fetch(`${baseUrl}/stream/candles?symbol=${SYMBOL}&timeframe=5m`);
      expect(response.status).toBe(400);
      await response.body?.cancel();
    });
  });
});
