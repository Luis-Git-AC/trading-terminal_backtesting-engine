import { Writable } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { timeframeToMs, type Candle, type Timeframe } from '@tt/shared';
import { runMigrations } from '../db/migrate.js';
import { createCandlesRepository, type CandlesRepository } from '../db/repositories/candles.repo.js';
import { createIngestStateRepository } from '../db/repositories/ingest-state.repo.js';
import type { CandleFeed, CandleFeedQuery } from '../ingest/backfill.js';
import { createLogger, type AppLogger } from '../observability/logger.js';
import { createCandlePublisher, type CandlePublisher, type RedisPublisher } from '../queue/pubsub.js';
import { startFakeBitgetWs, type FakeBitgetWs } from '../testing/fake-bitget-ws.js';
import { createScratchDatabase, type ScratchDatabase } from '../testing/scratch-db.js';
import { startIngestor, type IngestorHandle } from './ingestor.js';

const SYMBOL = 'ROLEUSDT';
const TIMEFRAME: Timeframe = '1m';
const STEP = timeframeToMs(TIMEFRAME);
const START = Date.UTC(2026, 6, 1, 0, 0, 0);

function makeCandle(index: number): Candle {
  const base = 64_000 + index;
  return { t: START + index * STEP, o: base, h: base + 10, l: base - 10, c: base + 5, v: 1 + index };
}

const upstream = Array.from({ length: 30 }, (_, index) => makeCandle(index));

function createFeed(available: readonly Candle[] = []): CandleFeed {
  const ascending = [...available].sort((a, b) => a.t - b.t);
  return {
    async getHistoryCandles(query: CandleFeedQuery): Promise<Candle[]> {
      await Promise.resolve();
      const end = query.endTime ?? Number.POSITIVE_INFINITY;
      const limit = query.limit ?? 200;
      const before = ascending.filter((candle) => candle.t < end);
      return before.slice(Math.max(0, before.length - limit));
    },
  };
}

interface LogCapture {
  logger: AppLogger;
  records(): Record<string, unknown>[];
  find(msg: string): Record<string, unknown> | undefined;
}

function captureLogger(): LogCapture {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString('utf8'));
      callback();
    },
  });

  const records = (): Record<string, unknown>[] =>
    chunks
      .join('')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  return {
    logger: createLogger({ role: 'ingestor', level: 'debug', destination }),
    records,
    find: (msg) => records().find((record) => record.msg === msg),
  };
}

interface FlakyRedis extends RedisPublisher {
  readonly published: string[];
  down: boolean;
}

function createFlakyRedis(): FlakyRedis {
  const published: string[] = [];
  const redis: FlakyRedis = {
    published,
    down: false,
    publish: async (_channel: string, message: string): Promise<unknown> => {
      await Promise.resolve();
      if (redis.down) throw new Error('Stream is not writeable: enableOfflineQueue esta desactivado');
      published.push(message);
      return 1;
    },
    quit: async (): Promise<unknown> => {
      await Promise.resolve();
      return 'OK';
    },
  };
  return redis;
}

describe('startIngestor', () => {
  let db: ScratchDatabase;
  let candles: CandlesRepository;
  let exchange: FakeBitgetWs;
  let handle: IngestorHandle | undefined;
  let logs: LogCapture;
  let redis: FlakyRedis;
  let publisher: CandlePublisher;

  beforeAll(async () => {
    db = await createScratchDatabase({ applicationName: 'tt-itest-role' });
    await runMigrations({ pool: db.pool });
  });

  afterAll(async () => {
    await db.pool.end().catch(() => undefined);
    await db.drop().catch(() => undefined);
  });

  beforeEach(async () => {
    await db.pool.query('TRUNCATE candles');
    await db.pool.query('TRUNCATE ingest_gaps');
    await db.pool.query('TRUNCATE ingest_state');
    candles = createCandlesRepository(db.pool);
    exchange = await startFakeBitgetWs();
    logs = captureLogger();
    redis = createFlakyRedis();
    publisher = createCandlePublisher({ redis });
    handle = undefined;
  });

  afterEach(async () => {
    await handle?.stop('test');
    await exchange.stop();
  });

  async function launch(
    overrides: Partial<Parameters<typeof startIngestor>[0]> = {},
  ): Promise<IngestorHandle> {
    const pool = await createScratchPool();
    const created = await startIngestor({
      pool,
      feed: createFeed(),
      publisher,
      logger: logs.logger,
      series: [{ symbol: SYMBOL, timeframe: TIMEFRAME }],
      backfillFrom: START,
      wsUrl: exchange.url,
      wsStaleTimeoutMs: undefined,
      metricsIntervalMs: 0,
      signals: [],
      ...overrides,
    });
    handle = created;

    await vi.waitFor(() => {
      expect(exchange.subscriptions).toHaveLength(1);
    });

    return created;
  }

  async function createScratchPool() {
    const { createPool } = await import('../db/pool.js');
    return createPool({ connectionString: db.connectionString, max: 4, applicationName: 'tt-role' });
  }

  async function storedIndices(): Promise<number[]> {
    const { rows } = await db.pool.query<{ ts: Date }>(
      'SELECT ts FROM candles WHERE symbol = $1 ORDER BY ts ASC',
      [SYMBOL],
    );
    return rows.map((row) => (row.ts.getTime() - START) / STEP);
  }

  it('arranca, se suscribe y persiste las velas cerradas que llegan por el socket', async () => {
    await launch();

    for (const candle of upstream.slice(0, 6)) {
      exchange.pushCandle(candle, SYMBOL, TIMEFRAME);
    }

    await vi.waitFor(
      async () => {
        expect(await storedIndices()).toEqual([0, 1, 2, 3, 4]);
      },
      { timeout: 10_000 },
    );

    expect(JSON.parse(exchange.subscriptions[0] ?? '{}')).toMatchObject({
      channel: 'candle1m',
      instId: SYMBOL,
    });
  });

  it('crea ingest_state para cada serie y no aplica migraciones', async () => {
    await launch();

    const state = createIngestStateRepository(db.pool);
    const stored = await state.get({ symbol: SYMBOL, timeframe: TIMEFRAME });
    expect(stored).toMatchObject({ symbol: SYMBOL, timeframe: TIMEFRAME });
  });

  it('todos los logs son JSON parseable y llevan role=ingestor', async () => {
    await launch();

    const records = logs.records();
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((record) => record.role === 'ingestor')).toBe(true);
    expect(logs.find('ingestor arrancado')).toBeDefined();
  });

  it('reconcilia al arrancar y lo deja en el log', async () => {
    await launch({ feed: createFeed(upstream) });

    const reconcile = logs.records().filter((record) => record.msg === 'reconciliacion');
    expect(reconcile).toHaveLength(1);
    expect(reconcile[0]).toMatchObject({ symbol: SYMBOL, timeframe: TIMEFRAME, trigger: 'arranque' });
  });

  it('publica las metricas con el estado del socket, reconexiones y huecos abiertos', async () => {
    const created = await launch();

    for (const candle of upstream.slice(0, 4)) {
      exchange.pushCandle(candle, SYMBOL, TIMEFRAME);
    }
    await vi.waitFor(
      async () => {
        expect(await storedIndices()).toHaveLength(3);
      },
      { timeout: 10_000 },
    );
    await created.ingestor.flush();

    const snapshot = await created.metrics();

    expect(snapshot.socketState).toBe('open');
    expect(snapshot.reconnects).toBe(0);
    expect(snapshot.openGaps).toBe(0);
    expect(snapshot.series[0]).toMatchObject({
      symbol: SYMBOL,
      timeframe: TIMEFRAME,
      lastCandleTs: START + 2 * STEP,
    });
    expect(snapshot.series[0]?.candlesPerMin).toBeGreaterThan(0);
  });

  it('la metrica cuenta velas ingeridas, no filas modificadas por el upsert', async () => {
    await candles.upsertCandles({
      symbol: SYMBOL,
      timeframe: TIMEFRAME,
      source: 'ws',
      candles: upstream.slice(0, 6),
    });

    const created = await launch();
    const flushes: { candles: number; written: number }[] = [];
    created.ingestor.on((event) => {
      if (event.kind === 'flushed') {
        flushes.push({ candles: event.candles, written: event.written });
      }
    });

    for (const candle of upstream.slice(0, 6)) {
      exchange.pushCandle(candle, SYMBOL, TIMEFRAME);
    }

    await vi.waitFor(
      () => {
        expect(flushes.length).toBeGreaterThan(0);
      },
      { timeout: 10_000 },
    );

    const total = flushes.reduce(
      (acc, flush) => ({
        candles: acc.candles + flush.candles,
        written: acc.written + flush.written,
      }),
      { candles: 0, written: 0 },
    );

    expect(total.written).toBe(0);
    expect(total.candles).toBeGreaterThan(0);
    expect((await created.metrics()).series[0]?.candlesPerMin).toBeGreaterThan(0);
  });

  it('reconcilia otra vez al reabrir el socket y cuenta la reconexion', async () => {
    const created = await launch({ feed: createFeed(upstream), wsReconnectBaseMs: 20, wsReconnectMaxMs: 60 });

    exchange.cutConnections();

    await vi.waitFor(
      () => {
        expect(exchange.connections()).toBe(2);
      },
      { timeout: 10_000 },
    );
    await vi.waitFor(
      () => {
        expect(logs.records().filter((record) => record.trigger === 'reconexion')).toHaveLength(1);
      },
      { timeout: 10_000 },
    );

    expect((await created.metrics()).reconnects).toBeGreaterThanOrEqual(1);
  });

  it('expone la salud de la ingesta con el estado del socket y las series', async () => {
    const created = await launch();

    for (const candle of upstream.slice(0, 4)) {
      exchange.pushCandle(candle, SYMBOL, TIMEFRAME);
    }
    await vi.waitFor(
      async () => {
        expect(await storedIndices()).toHaveLength(3);
      },
      { timeout: 10_000 },
    );
    await created.ingestor.flush();

    const health = await created.health();

    expect(health.socketState).toBe('open');
    expect(health.consecutiveFailures).toBe(0);
    expect(health.series[0]).toMatchObject({
      symbol: SYMBOL,
      timeframe: TIMEFRAME,
      lastCandleTs: START + 2 * STEP,
      stale: true,
    });
    expect(health.status).toBe('degraded');
  });

  it('la salud sale ok cuando la ultima vela es reciente', async () => {
    const clock = START + 3 * STEP;
    const created = await launch({ now: () => clock });

    for (const candle of upstream.slice(0, 4)) {
      exchange.pushCandle(candle, SYMBOL, TIMEFRAME);
    }
    await vi.waitFor(
      async () => {
        expect(await storedIndices()).toHaveLength(3);
      },
      { timeout: 10_000 },
    );
    await created.ingestor.flush();

    const health = await created.health();

    expect(health.series[0]?.stale).toBe(false);
    expect(health.status).toBe('ok');
    expect(health.openGaps).toBe(0);
  });

  it('tras demasiados fallos seguidos del socket lo registra a nivel error', async () => {
    await exchange.stop();

    const created = await startIngestor({
      pool: await createScratchPool(),
      feed: createFeed(),
      publisher,
      logger: logs.logger,
      series: [{ symbol: SYMBOL, timeframe: TIMEFRAME }],
      backfillFrom: START,
      wsUrl: 'ws://127.0.0.1:1',
      wsReconnectBaseMs: 100,
      wsReconnectMaxMs: 120,
      wsMaxConsecutiveFailures: 2,
      metricsIntervalMs: 0,
      signals: [],
      exit: () => undefined,
    });
    handle = created;

    await vi.waitFor(
      () => {
        const degraded = logs
          .records()
          .filter(
            (record) =>
              record.msg ===
              'la ingesta lleva demasiados fallos seguidos: se sigue reintentando al backoff maximo',
          );
        expect(degraded.length).toBeGreaterThan(0);
        expect(degraded[0]?.level).toBe('error');
      },
      { timeout: 15_000 },
    );

    expect(created.stream.socket.degraded).toBe(true);
    expect((await created.metrics()).degraded).toBe(true);

    exchange = await startFakeBitgetWs();
  });

  describe('degradacion de Redis', () => {
    it('un fallo de Redis no tira el proceso: sigue persistiendo, deja de publicar y se recupera', async () => {
      await launch();

      for (const candle of upstream.slice(0, 3)) {
        exchange.pushCandle(candle, SYMBOL, TIMEFRAME);
      }
      await vi.waitFor(
        async () => {
          expect(await storedIndices()).toEqual([0, 1]);
        },
        { timeout: 10_000 },
      );
      const publishedBefore = redis.published.length;
      expect(publishedBefore).toBeGreaterThan(0);

      redis.down = true;

      for (const candle of upstream.slice(3, 8)) {
        exchange.pushCandle(candle, SYMBOL, TIMEFRAME);
      }
      await vi.waitFor(
        async () => {
          expect(await storedIndices()).toEqual([0, 1, 2, 3, 4, 5, 6]);
        },
        { timeout: 10_000 },
      );
      expect(redis.published).toHaveLength(publishedBefore);

      redis.down = false;

      for (const candle of upstream.slice(8, 11)) {
        exchange.pushCandle(candle, SYMBOL, TIMEFRAME);
      }
      await vi.waitFor(
        () => {
          expect(redis.published.length).toBeGreaterThan(publishedBefore);
        },
        { timeout: 10_000 },
      );
      await vi.waitFor(
        async () => {
          expect(await storedIndices()).toHaveLength(10);
        },
        { timeout: 10_000 },
      );
    });
  });

  describe('apagado', () => {
    it('SIGTERM vacia el buffer, cierra el socket sin reconectar y sale con 0 en menos de 15 s', async () => {
      const codes: number[] = [];
      const created = await startIngestor({
        pool: await createScratchPool(),
        feed: createFeed(),
        publisher,
        logger: logs.logger,
        series: [{ symbol: SYMBOL, timeframe: TIMEFRAME }],
        backfillFrom: START,
        wsUrl: exchange.url,
        metricsIntervalMs: 0,
        shutdownTimeoutMs: 15_000,
        exit: (code) => codes.push(code),
      });
      handle = created;

      await vi.waitFor(() => {
        expect(exchange.subscriptions).toHaveLength(1);
      });

      for (const candle of upstream.slice(0, 4)) {
        exchange.pushCandle(candle, SYMBOL, TIMEFRAME);
      }
      await vi.waitFor(() => {
        expect(created.ingestor.pending).toBe(3);
      });

      const startedAt = Date.now();
      process.emit('SIGTERM');

      await vi.waitFor(
        async () => {
          expect(await storedIndices()).toEqual([0, 1, 2]);
        },
        { timeout: 15_000 },
      );
      await vi.waitFor(
        () => {
          expect(codes).toEqual([0]);
        },
        { timeout: 15_000 },
      );

      const elapsed = Date.now() - startedAt;
      expect(elapsed, `el apagado tardo ${elapsed} ms`).toBeLessThan(15_000);
      expect(created.ingestor.pending).toBe(0);
      expect(created.stream.socket.state).toBe('closed');
      expect(logs.find('ingestor apagado')).toBeDefined();

      handle = undefined;
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(exchange.connections()).toBe(1);
    });

    it('stop() quita los handlers de senal que instalo el arranque', async () => {
      const before = process.listenerCount('SIGTERM');
      const created = await startIngestor({
        pool: await createScratchPool(),
        feed: createFeed(),
        publisher,
        logger: logs.logger,
        series: [{ symbol: SYMBOL, timeframe: TIMEFRAME }],
        backfillFrom: START,
        wsUrl: exchange.url,
        metricsIntervalMs: 0,
        exit: () => undefined,
      });

      expect(process.listenerCount('SIGTERM')).toBe(before + 1);

      await created.stop('test');
      handle = undefined;

      expect(process.listenerCount('SIGTERM')).toBe(before);
    });

    it('llamar a stop() dos veces no repite el apagado', async () => {
      const created = await launch();

      await created.stop('primera');
      await created.stop('segunda');
      handle = undefined;

      expect(logs.records().filter((record) => record.msg === 'ingestor apagado')).toHaveLength(1);
    });
  });

  it('el ciclo de auditoria de huecos detecta y rellena lo que falta', async () => {
    const created = await launch({
      feed: createFeed(upstream),
      now: () => START + 20 * STEP,
    });

    await candles.upsertCandles({
      symbol: SYMBOL,
      timeframe: TIMEFRAME,
      source: 'ws',
      candles: upstream.slice(0, 20),
    });
    await db.pool.query('DELETE FROM candles WHERE symbol = $1 AND ts = ANY($2::timestamptz[])', [
      SYMBOL,
      [new Date(START + 5 * STEP), new Date(START + 6 * STEP)],
    ]);

    await created.runGapCycle();

    expect(await storedIndices()).toEqual(Array.from({ length: 20 }, (_, index) => index));
    const audit = logs.find('auditoria de huecos');
    expect(audit).toMatchObject({ found: 1, recorded: 1, filled: 1 });
  });
});
