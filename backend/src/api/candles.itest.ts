import type { Candle, Exchange, Timeframe } from '@tt/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCandlesRepository,
  type CandlesRepository,
} from '../db/repositories/candles.repo.js';
import {
  createIngestStateRepository,
  type IngestStateRepository,
} from '../db/repositories/ingest-state.repo.js';
import { runMigrations } from '../db/migrate.js';
import { createLogger } from '../observability/logger.js';
import { createScratchDatabase, type ScratchDatabase } from '../testing/scratch-db.js';
import { candlesRouter } from './routes/candles.js';
import { marketsRouter } from './routes/markets.js';
import { NO_CACHE, type CacheStore } from './services/cache.js';
import { createApiApp } from './server.js';

const SYMBOL = 'APIUSDT';
const TIMEFRAME: Timeframe = '1m';
const STEP = 60_000;
const START = Date.UTC(2026, 6, 1, 0, 0, 0);
const NOW = START + 200 * STEP;

function makeCandle(index: number): Candle {
  const base = 100 + index;
  return {
    t: START + index * STEP,
    o: base,
    h: base + 1,
    l: base - 1,
    c: base + 0.5,
    v: 10 + index,
  };
}

function memoryCache(): CacheStore & { entries: Map<string, string>; sets: number } {
  const entries = new Map<string, string>();
  return {
    entries,
    sets: 0,
    get(key) {
      return Promise.resolve(entries.get(key) ?? null);
    },
    set(key, value) {
      entries.set(key, value);
      this.sets += 1;
      return Promise.resolve();
    },
  };
}

describe('API de mercado y velas', () => {
  let db: ScratchDatabase;
  let candles: CandlesRepository;
  let ingestState: IngestStateRepository;

  beforeAll(async () => {
    db = await createScratchDatabase({ applicationName: 'tt-itest-api-candles' });
    await runMigrations({ pool: db.pool });
    candles = createCandlesRepository(db.pool);
    ingestState = createIngestStateRepository(db.pool);
  });

  afterAll(async () => {
    await db.drop();
  });

  beforeEach(async () => {
    await db.pool.query('TRUNCATE candles');
    await db.pool.query('TRUNCATE ingest_state');
    await candles.upsertCandles({
      symbol: SYMBOL,
      timeframe: TIMEFRAME,
      source: 'rest',
      candles: Array.from({ length: 100 }, (_, index) => makeCandle(index)),
    });
    await ingestState.ensure({ symbol: SYMBOL, timeframe: TIMEFRAME, targetTs: START });
  });

  function makeApp(cache: CacheStore = NO_CACHE, repo: CandlesRepository = candles) {
    const logger = createLogger({ role: 'api', level: 'silent' });
    const deps = {
      candles: repo,
      ingestState,
      cache,
      logger,
      exchanges: [{ exchange: 'binance' as const, symbols: [SYMBOL] }],
      timeframes: ['1m', '15m', '1h'] as Timeframe[],
      now: () => NOW,
    };

    return createApiApp({
      logger,
      webOrigin: 'https://terminal.example',
      version: '0.1.0',
      uptimeSec: () => 1,
      checkDb: () => Promise.resolve(),
      checkRedis: () => Promise.resolve(),
      registerRoutes: (router) => {
        router.use(marketsRouter(deps));
        router.use(candlesRouter({ ...deps, markets: deps }));
      },
    });
  }

  describe('GET /api/markets', () => {
    it('lista los simbolos con sus timeframes y precisiones', async () => {
      const response = await request(makeApp()).get('/api/markets');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        exchanges: [
          {
            exchange: 'binance',
            symbols: [
              {
                symbol: SYMBOL,
                timeframes: ['1m', '15m', '1h'],
                pricePrecision: 1,
                qtyPrecision: 4,
              },
            ],
          },
        ],
      });
    });
  });

  describe('GET /api/markets/:exchange/:symbol/coverage', () => {
    it('devuelve el rango cubierto, lo esperado y los huecos', async () => {
      const response = await request(makeApp()).get(
        `/api/markets/binance/${SYMBOL}/coverage?timeframe=1m`,
      );

      expect(response.status).toBe(200);
      expect(response.body.symbol).toBe(SYMBOL);
      expect(response.body.candles).toBe(100);
      expect(response.body.expected).toBe(100);
      expect(response.body.missing).toBe(0);
      expect(response.body.gaps).toEqual([]);
      expect(response.body.from).toBe(new Date(START).toISOString());
      expect(response.body.backfill).toEqual({ done: false, cursor: null });
    });

    it('detecta un hueco real y lo reporta con su rango', async () => {
      await db.pool.query('DELETE FROM candles WHERE ts = $1', [new Date(START + 40 * STEP)]);

      const response = await request(makeApp()).get(
        `/api/markets/binance/${SYMBOL}/coverage?timeframe=1m`,
      );

      expect(response.body.candles).toBe(99);
      expect(response.body.missing).toBe(1);
      expect(response.body.gaps).toHaveLength(1);
      expect(response.body.gaps[0]).toEqual({
        from: new Date(START + 40 * STEP).toISOString(),
        to: new Date(START + 40 * STEP).toISOString(),
        filled: false,
      });
    });

    it('una serie vacia no revienta', async () => {
      await db.pool.query('TRUNCATE candles');

      const response = await request(makeApp()).get(
        `/api/markets/binance/${SYMBOL}/coverage?timeframe=15m`,
      );

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        from: null,
        to: null,
        candles: 0,
        expected: 0,
        missing: 0,
        gaps: [],
      });
    });

    it('un timeframe fuera del contrato da 400 con details', async () => {
      const response = await request(makeApp()).get(
        `/api/markets/binance/${SYMBOL}/coverage?timeframe=5m`,
      );

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(response.body.error.details[0].path).toBe('query.timeframe');
    });

    it('un simbolo desconocido da 404', async () => {
      const response = await request(makeApp()).get(
        '/api/markets/binance/NOPEUSDT/coverage?timeframe=1m',
      );
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('GET /api/candles', () => {
    it('devuelve las velas en formato compacto', async () => {
      const response = await request(makeApp()).get(
        `/api/candles?exchange=binance&symbol=${SYMBOL}&timeframe=1m&from=${START}&to=${START + 10 * STEP}`,
      );

      expect(response.status).toBe(200);
      expect(response.body.count).toBe(10);
      expect(response.body.candles[0]).toEqual({
        t: START,
        o: 100,
        h: 101,
        l: 99,
        c: 100.5,
        v: 10,
      });
      expect(response.body.nextFrom).toBeNull();
    });

    it('acepta fechas ISO ademas de epoch en milisegundos', async () => {
      const from = new Date(START).toISOString();
      const to = new Date(START + 5 * STEP).toISOString();

      const response = await request(makeApp()).get(
        `/api/candles?exchange=binance&symbol=${SYMBOL}&timeframe=1m&from=${from}&to=${to}`,
      );

      expect(response.status).toBe(200);
      expect(response.body.count).toBe(5);
    });

    it('pagina con nextFrom cuando se alcanza el limit', async () => {
      const response = await request(makeApp()).get(
        `/api/candles?exchange=binance&symbol=${SYMBOL}&timeframe=1m&from=${START}&to=${START + 100 * STEP}&limit=10`,
      );

      expect(response.body.count).toBe(10);
      expect(response.body.nextFrom).toBe(START + 10 * STEP);
    });

    it('limit=99999 da 413 RANGE_TOO_LARGE', async () => {
      const response = await request(makeApp()).get(
        `/api/candles?exchange=binance&symbol=${SYMBOL}&timeframe=1m&from=${START}&limit=99999`,
      );

      expect(response.status).toBe(413);
      expect(response.body.error.code).toBe('RANGE_TOO_LARGE');
    });

    it('timeframe=5m da 400 VALIDATION_ERROR con details', async () => {
      const response = await request(makeApp()).get(
        `/api/candles?exchange=binance&symbol=${SYMBOL}&timeframe=5m&from=${START}`,
      );

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(response.body.error.details[0].path).toBe('query.timeframe');
    });

    it('sin to usa el momento actual', async () => {
      const response = await request(makeApp()).get(
        `/api/candles?exchange=binance&symbol=${SYMBOL}&timeframe=1m&from=${START}`,
      );

      expect(response.status).toBe(200);
      expect(response.body.count).toBe(100);
    });

    it('la segunda llamada identica se sirve de cache y no toca la base de datos', async () => {
      const cache = memoryCache();
      const spy = vi.fn(candles.getCandles.bind(candles));
      const repo: CandlesRepository = { ...candles, getCandles: spy };
      const app = makeApp(cache, repo);
      const url = `/api/candles?exchange=binance&symbol=${SYMBOL}&timeframe=1m&from=${START}&to=${START + 10 * STEP}`;

      const first = await request(app).get(url);
      const second = await request(app).get(url);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(second.body).toEqual(first.body);
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('dos rangos distintos no comparten entrada de cache', async () => {
      const cache = memoryCache();
      const app = makeApp(cache);

      const short = await request(app).get(
        `/api/candles?exchange=binance&symbol=${SYMBOL}&timeframe=1m&from=${START}&to=${START + 5 * STEP}`,
      );
      const long = await request(app).get(
        `/api/candles?exchange=binance&symbol=${SYMBOL}&timeframe=1m&from=${START}&to=${START + 20 * STEP}`,
      );

      expect(short.body.count).toBe(5);
      expect(long.body.count).toBe(20);
      expect(cache.entries.size).toBe(2);
    });

    it('con la cache caida la respuesta sigue siendo 200', async () => {
      const broken: CacheStore = {
        get: () => Promise.reject(new Error('redis caido')),
        set: () => Promise.reject(new Error('redis caido')),
      };

      const response = await request(makeApp(broken)).get(
        `/api/candles?exchange=binance&symbol=${SYMBOL}&timeframe=1m&from=${START}&to=${START + 3 * STEP}`,
      );

      expect(response.status).toBe(200);
      expect(response.body.count).toBe(3);
    });

    it('un simbolo desconocido da 404', async () => {
      const response = await request(makeApp()).get(
        `/api/candles?exchange=binance&symbol=NOPEUSDT&timeframe=1m&from=${START}`,
      );
      expect(response.status).toBe(404);
    });

    it('un rango invertido da 400', async () => {
      const response = await request(makeApp()).get(
        `/api/candles?exchange=binance&symbol=${SYMBOL}&timeframe=1m&from=${START + 10 * STEP}&to=${START}`,
      );
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('(exchange, symbol) como identidad de la serie', () => {
    const OTHER = 'hyperliquid' as const;

    function multiApp(cache: CacheStore, served: readonly Exchange[] = ['binance', OTHER]) {
      const logger = createLogger({ role: 'api', level: 'silent' });
      const deps = {
        candles,
        ingestState,
        cache,
        logger,
        exchanges: served.map((exchange) => ({ exchange, symbols: [SYMBOL] })),
        timeframes: ['1m', '15m', '1h'] as Timeframe[],
        now: () => NOW,
      };

      return createApiApp({
        logger,
        webOrigin: 'https://terminal.example',
        version: '0.1.0',
        uptimeSec: () => 1,
        checkDb: () => Promise.resolve(),
        checkRedis: () => Promise.resolve(),
        registerRoutes: (router) => {
          router.use(marketsRouter(deps));
          router.use(candlesRouter({ ...deps, markets: deps }));
        },
      });
    }

    beforeEach(async () => {
      await candles.upsertCandles({
        exchange: OTHER,
        symbol: SYMBOL,
        timeframe: TIMEFRAME,
        source: 'rest',
        candles: Array.from({ length: 10 }, (_, index) => makeCandle(index)),
      });
    });

    it('el mismo simbolo en dos exchanges da coberturas distintas y no se contaminan por cache', async () => {
      const cache = memoryCache();
      const app = multiApp(cache);

      const mine = await request(app).get(`/api/markets/binance/${SYMBOL}/coverage?timeframe=1m`);
      const other = await request(app).get(`/api/markets/${OTHER}/${SYMBOL}/coverage?timeframe=1m`);

      expect(mine.body.exchange).toBe('binance');
      expect(other.body.exchange).toBe(OTHER);
      expect(mine.body.candles).toBe(100);
      expect(other.body.candles).toBe(10);
      expect([...cache.entries.keys()].sort()).toEqual([
        `coverage:v1:binance:${SYMBOL}:1m`,
        `coverage:v1:${OTHER}:${SYMBOL}:1m`,
      ]);
    });

    it('las velas tambien salen por exchange y con su propia clave de cache', async () => {
      const cache = memoryCache();
      const app = multiApp(cache);
      const range = `timeframe=1m&from=${START}&to=${START + 100 * STEP}`;

      const mine = await request(app).get(
        `/api/candles?exchange=binance&symbol=${SYMBOL}&${range}`,
      );
      const other = await request(app).get(
        `/api/candles?exchange=${OTHER}&symbol=${SYMBOL}&${range}`,
      );

      expect(mine.body.count).toBe(100);
      expect(other.body.count).toBe(10);
      expect(cache.entries.size).toBe(2);
    });

    it('un exchange no servido da 404 con code UNKNOWN_EXCHANGE', async () => {
      // Esta instancia solo sirve binance, aunque hyperliquid exista en el contrato.
      const response = await request(multiApp(NO_CACHE, ['binance'])).get(
        `/api/markets/hyperliquid/${SYMBOL}/coverage?timeframe=1m`,
      );

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('UNKNOWN_EXCHANGE');
    });

    it('un exchange que no existe en el contrato da 400', async () => {
      const response = await request(multiApp(NO_CACHE)).get(
        `/api/markets/kraken/${SYMBOL}/coverage?timeframe=1m`,
      );

      expect(response.status).toBe(400);
      expect(response.body.error.details[0].path).toBe('params.exchange');
    });
  });
});
