import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { timeframeToMs, type Candle, type Timeframe } from '@tt/shared';
import { runMigrations } from '../db/migrate.js';
import { createCandlesRepository, type CandlesRepository } from '../db/repositories/candles.repo.js';
import {
  createIngestStateRepository,
  type IngestStateRepository,
} from '../db/repositories/ingest-state.repo.js';
import {
  candleChannel,
  createCandlePublisher,
  createRedisClient,
  type CandleTick,
} from '../queue/pubsub.js';
import {
  startFakeBitgetWs,
  updateFrame as buildUpdateFrame,
  type FakeBitgetWs,
} from '../testing/fake-bitget-ws.js';
import { createScratchDatabase, type ScratchDatabase } from '../testing/scratch-db.js';
import { createBitgetCandleStream, type BitgetStreamEvent } from './exchange/bitget/ws.js';
import { createLiveIngestor, type LiveIngestor } from './live-ingestor.js';

const SYMBOL = 'BTCUSDT';
const TIMEFRAME: Timeframe = '1m';
const STEP = timeframeToMs(TIMEFRAME);
const START = Date.UTC(2026, 6, 1, 0, 0, 0);
const CHANNEL = candleChannel(SYMBOL, TIMEFRAME);

function makeCandle(index: number): Candle {
  const base = 64_000 + index;
  return { t: START + index * STEP, o: base, h: base + 10, l: base - 10, c: base + 5, v: 1 + index };
}

function updateFrame(candle: Candle, symbol = SYMBOL): string {
  return buildUpdateFrame(candle, symbol, TIMEFRAME);
}

interface RedisSpy {
  messages: CandleTick[];
  stop(): Promise<void>;
}

async function subscribeRedis(url: string, channel: string): Promise<RedisSpy> {
  const client = new Redis(url, { maxRetriesPerRequest: null });
  const messages: CandleTick[] = [];

  client.on('message', (received: string, payload: string) => {
    if (received === channel) messages.push(JSON.parse(payload) as CandleTick);
  });

  await client.subscribe(channel);

  return {
    messages,
    async stop() {
      await client.quit();
    },
  };
}

function requireRedisUrl(): string {
  const url = process.env.REDIS_URL;
  if (url === undefined || url.length === 0) {
    throw new Error('REDIS_URL no esta definida. Copia .env.example a .env y ejecuta npm run db:up.');
  }
  return url;
}

describe('createLiveIngestor', () => {
  let db: ScratchDatabase;
  let candles: CandlesRepository;
  let state: IngestStateRepository;
  let exchange: FakeBitgetWs;
  let spy: RedisSpy;
  let ingestor: LiveIngestor | undefined;
  let emitted: BitgetStreamEvent[];
  const redisUrl = requireRedisUrl();

  beforeAll(async () => {
    db = await createScratchDatabase({ applicationName: 'tt-itest-live' });
    await runMigrations({ pool: db.pool });
    candles = createCandlesRepository(db.pool);
    state = createIngestStateRepository(db.pool);
  });

  afterAll(async () => {
    await db.drop();
  });

  beforeEach(async () => {
    await db.pool.query('TRUNCATE candles');
    await db.pool.query('TRUNCATE ingest_state');
    await state.ensure({ symbol: SYMBOL, timeframe: TIMEFRAME, targetTs: START });
    exchange = await startFakeBitgetWs();
    spy = await subscribeRedis(redisUrl, CHANNEL);
    emitted = [];
    ingestor = undefined;
  });

  afterEach(async () => {
    await ingestor?.stop();
    await spy.stop();
    await exchange.stop();
  });

  async function launch(flushIntervalMs = 200): Promise<LiveIngestor> {
    const stream = createBitgetCandleStream({
      url: exchange.url,
      staleTimeoutMs: 0,
      heartbeatIntervalMs: 0,
      reconnectBaseMs: 20,
      reconnectMaxMs: 50,
      now: () => 0,
    });
    stream.on((event) => {
      if (event.kind === 'candle') emitted.push(event);
    });

    const created = createLiveIngestor({
      stream,
      candles,
      state,
      publisher: createCandlePublisher({ redis: createRedisClient(redisUrl) }),
      series: [{ symbol: SYMBOL, timeframe: TIMEFRAME }],
      flushIntervalMs,
      wsTouchIntervalMs: 0,
    });

    ingestor = created;
    created.start();

    await vi.waitFor(() => {
      expect(exchange.subscriptions).toHaveLength(1);
    });

    return created;
  }

  async function storedTimestamps(): Promise<number[]> {
    const { rows } = await db.pool.query<{ ts: Date }>(
      'SELECT ts FROM candles WHERE symbol = $1 AND timeframe = $2 ORDER BY ts ASC',
      [SYMBOL, TIMEFRAME],
    );
    return rows.map((row) => row.ts.getTime());
  }

  it('suscribe la serie con el canal y el instType de Bitget', async () => {
    await launch();

    expect(JSON.parse(exchange.subscriptions[0] ?? '{}')).toEqual({
      instType: 'USDT-FUTURES',
      channel: 'candle1m',
      instId: SYMBOL,
    });
  });

  it('50 velas emitidas por el servidor WS acaban como 50 filas en orden y sin duplicados', async () => {
    await launch();

    for (let index = 0; index <= 50; index += 1) {
      exchange.push(updateFrame(makeCandle(index)));
    }

    await vi.waitFor(
      async () => {
        expect(await storedTimestamps()).toHaveLength(50);
      },
      { timeout: 10_000 },
    );

    const stored = await storedTimestamps();
    const expected = Array.from({ length: 50 }, (_, index) => START + index * STEP);

    expect(stored).toEqual(expected);
    expect(new Set(stored).size).toBe(50);
    expect(await candles.findDuplicates({ symbol: SYMBOL, timeframe: TIMEFRAME, from: START, to: START + 60 * STEP })).toEqual([]);
  });

  it('la vela en formacion no llega a la base de datos', async () => {
    await launch(50);

    const forming = makeCandle(0);
    for (let tick = 0; tick < 5; tick += 1) {
      exchange.push(updateFrame({ ...forming, c: forming.c + tick, v: forming.v + tick }));
    }

    await vi.waitFor(() => {
      expect(spy.messages).toHaveLength(5);
    });
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(await storedTimestamps()).toEqual([]);
    expect(spy.messages.every((tick) => !tick.closed)).toBe(true);
  });

  it('los mensajes publicados en Redis coinciden 1:1 con lo emitido por el stream', async () => {
    await launch();

    for (let index = 0; index <= 3; index += 1) {
      exchange.push(updateFrame(makeCandle(index)));
      exchange.push(updateFrame(makeCandle(index)));
    }

    await vi.waitFor(
      async () => {
        expect(await storedTimestamps()).toHaveLength(3);
      },
      { timeout: 10_000 },
    );
    await vi.waitFor(() => {
      expect(spy.messages).toHaveLength(emitted.length);
    });

    const published = spy.messages.map((tick) => `${tick.t} ${tick.c} ${tick.closed}`);
    const expected = emitted.map(
      (event) =>
        `${event.kind === 'candle' ? event.candle.t : -1} ${
          event.kind === 'candle' ? event.candle.c : -1
        } ${event.kind === 'candle' ? event.closed : false}`,
    );

    expect(published).toEqual(expected);
    expect(published.filter((line) => line.endsWith('true'))).toHaveLength(3);
  });

  it('agrupa las velas de una misma ventana en un solo upsert', async () => {
    const created = await launch(60_000);
    const flushes: number[] = [];
    created.on((event) => {
      if (event.kind === 'flushed') flushes.push(event.written);
    });

    for (let index = 0; index <= 10; index += 1) {
      exchange.push(updateFrame(makeCandle(index)));
    }

    await vi.waitFor(() => {
      expect(created.pending).toBe(10);
    });
    expect(await storedTimestamps()).toEqual([]);

    await created.flush();

    expect(flushes).toEqual([10]);
    expect(await storedTimestamps()).toHaveLength(10);
  });

  it('SIGTERM vacia el buffer pendiente antes de salir', async () => {
    const created = await launch(60_000);

    for (let index = 0; index <= 4; index += 1) {
      exchange.push(updateFrame(makeCandle(index)));
    }

    await vi.waitFor(() => {
      expect(created.pending).toBe(4);
    });
    expect(await storedTimestamps()).toEqual([]);

    process.emit('SIGTERM');

    await vi.waitFor(
      async () => {
        expect(await storedTimestamps()).toHaveLength(4);
      },
      { timeout: 10_000 },
    );
    expect(created.pending).toBe(0);
  });

  it('stop() quita el handler de senal que instalo start()', async () => {
    const before = process.listenerCount('SIGTERM');
    const created = await launch();
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);

    await created.stop();
    ingestor = undefined;

    expect(process.listenerCount('SIGTERM')).toBe(before);
  });

  it('avanza ingest_state.last_candle_ts y marca last_ws_message_at', async () => {
    await launch();

    for (let index = 0; index <= 3; index += 1) {
      exchange.push(updateFrame(makeCandle(index)));
    }

    await vi.waitFor(
      async () => {
        expect(await storedTimestamps()).toHaveLength(3);
      },
      { timeout: 10_000 },
    );

    const stored = await state.get({ symbol: SYMBOL, timeframe: TIMEFRAME });
    expect(stored?.lastCandleTs).toBe(START + 2 * STEP);

    const { rows } = await db.pool.query<{ last_ws_message_at: Date | null }>(
      'SELECT last_ws_message_at FROM ingest_state WHERE symbol = $1 AND timeframe = $2',
      [SYMBOL, TIMEFRAME],
    );
    expect(rows[0]?.last_ws_message_at).toBeInstanceOf(Date);
  });

  it('recibir dos veces la misma vela cerrada no duplica filas ni retrocede el cursor', async () => {
    const created = await launch(60_000);

    exchange.push(updateFrame(makeCandle(0)));
    exchange.push(updateFrame(makeCandle(1)));
    await vi.waitFor(() => {
      expect(created.pending).toBe(1);
    });
    await created.flush();

    exchange.push(updateFrame(makeCandle(0)));
    exchange.push(updateFrame(makeCandle(1)));
    await new Promise((resolve) => setTimeout(resolve, 300));
    await created.flush();

    expect(await storedTimestamps()).toEqual([START]);
    const stored = await state.get({ symbol: SYMBOL, timeframe: TIMEFRAME });
    expect(stored?.lastCandleTs).toBe(START);
  });

  it('un fallo de escritura devuelve las velas al buffer y se reintenta en el flush siguiente', async () => {
    const created = await launch(60_000);
    const errors: string[] = [];
    created.on((event) => {
      if (event.kind === 'error') errors.push(event.stage);
    });

    const upsert = vi
      .spyOn(candles, 'upsertCandles')
      .mockRejectedValueOnce(new Error('conexion caida'));

    exchange.push(updateFrame(makeCandle(0)));
    exchange.push(updateFrame(makeCandle(1)));
    await vi.waitFor(() => {
      expect(created.pending).toBe(1);
    });

    await created.flush();
    expect(errors).toEqual(['flush']);
    expect(created.pending).toBe(1);
    expect(await storedTimestamps()).toEqual([]);

    upsert.mockRestore();
    await created.flush();

    expect(created.pending).toBe(0);
    expect(await storedTimestamps()).toEqual([START]);
  });
});
