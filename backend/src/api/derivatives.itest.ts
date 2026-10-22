import type { Timeframe } from '@tt/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import {
  createDerivativesRepository,
  type DerivativesRepository,
} from '../db/repositories/derivatives.repo.js';
import { createLogger } from '../observability/logger.js';
import { createScratchDatabase, type ScratchDatabase } from '../testing/scratch-db.js';
import { derivativesRouter } from './routes/derivatives.js';
import { createApiApp } from './server.js';

const SYMBOL = 'XAUUSDT';
const HOUR = 3_600_000;
const START = Date.UTC(2026, 9, 19, 0, 0, 0);
const NOW = START + 48 * HOUR;

const FUNDING = Array.from({ length: 6 }, (_, index) => ({
  t: START + index * 4 * HOUR,
  rate: (index + 1) / 10_000,
  intervalHours: 4,
}));

describe('API de derivados', () => {
  let db: ScratchDatabase;
  let repo: DerivativesRepository;

  beforeAll(async () => {
    db = await createScratchDatabase({ applicationName: 'tt-itest-api-derivatives' });
    await runMigrations({ pool: db.pool });
    repo = createDerivativesRepository(db.pool);
  });

  afterAll(async () => {
    await db.drop();
  });

  beforeEach(async () => {
    await db.pool.query('TRUNCATE funding_rates');
    await db.pool.query('TRUNCATE open_interest');

    await repo.upsertFundingRates({
      exchange: 'binance',
      symbol: SYMBOL,
      source: 'rest',
      rates: FUNDING,
    });

    await repo.upsertOpenInterest({
      exchange: 'binance',
      symbol: SYMBOL,
      source: 'rest',
      points: Array.from({ length: 10 }, (_, index) => ({
        t: START + index * HOUR,
        base: 200_000 + index,
        quote: index === 9 ? null : (200_000 + index) * 4000,
      })),
    });
  });

  function makeApp() {
    const logger = createLogger({ role: 'api', level: 'silent' });
    const markets = {
      exchanges: [{ exchange: 'binance' as const, symbols: [SYMBOL] }],
      timeframes: ['1m', '15m', '1h'] as Timeframe[],
    };

    return createApiApp({
      logger,
      webOrigin: 'https://terminal.example',
      version: '0.1.0',
      uptimeSec: () => 1,
      checkDb: () => Promise.resolve(),
      checkRedis: () => Promise.resolve(),
      registerRoutes: (router) => {
        router.use(derivativesRouter({ derivatives: repo, markets, now: () => NOW }));
      },
    });
  }

  describe('GET /api/derivatives/:exchange/:symbol/funding', () => {
    it('devuelve el rango con su periodo y sin pagina siguiente', async () => {
      const response = await request(makeApp()).get(
        `/api/derivatives/binance/${SYMBOL}/funding?from=${START}`,
      );

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        exchange: 'binance',
        symbol: SYMBOL,
        count: 6,
        funding: FUNDING,
        nextFrom: null,
      });
    });

    it('el rango es semiabierto: `to` no entra', async () => {
      const response = await request(makeApp()).get(
        `/api/derivatives/binance/${SYMBOL}/funding?from=${START}&to=${START + 8 * HOUR}`,
      );

      expect(response.status).toBe(200);
      expect(response.body.count).toBe(2);
    });

    it('con `limit` alcanzado da `nextFrom` para seguir', async () => {
      const response = await request(makeApp()).get(
        `/api/derivatives/binance/${SYMBOL}/funding?from=${START}&limit=2`,
      );

      expect(response.body.count).toBe(2);
      expect(response.body.nextFrom).toBe(START + 4 * HOUR + 1);

      const next = await request(makeApp()).get(
        `/api/derivatives/binance/${SYMBOL}/funding?from=${response.body.nextFrom}&limit=2`,
      );
      expect(next.body.funding[0].t).toBe(START + 8 * HOUR);
    });

    it('un rango sin datos devuelve una lista vacia, no un 404', async () => {
      const response = await request(makeApp()).get(
        `/api/derivatives/binance/${SYMBOL}/funding?from=${START + 100 * HOUR}&to=${START + 200 * HOUR}`,
      );

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ count: 0, funding: [], nextFrom: null });
    });
  });

  describe('GET /api/derivatives/:exchange/:symbol/open-interest', () => {
    it('devuelve base y quote, con quote nulo cuando la fuente no lo da', async () => {
      const response = await request(makeApp()).get(
        `/api/derivatives/binance/${SYMBOL}/open-interest?from=${START}`,
      );

      expect(response.status).toBe(200);
      expect(response.body.count).toBe(10);
      expect(response.body.openInterest[0]).toEqual({
        t: START,
        base: 200_000,
        quote: 800_000_000,
      });
      expect(response.body.openInterest[9].quote).toBeNull();
    });
  });

  describe('errores del contrato', () => {
    it('un exchange desconocido da 404 UNKNOWN_EXCHANGE', async () => {
      const response = await request(makeApp()).get(
        `/api/derivatives/hyperliquid/${SYMBOL}/funding?from=${START}`,
      );

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('UNKNOWN_EXCHANGE');
    });

    it('un simbolo que no se sirve da 404', async () => {
      const response = await request(makeApp()).get(
        `/api/derivatives/binance/NOPEUSDT/funding?from=${START}`,
      );

      expect(response.status).toBe(404);
    });

    it('sin `from` da 400 VALIDATION_ERROR', async () => {
      const response = await request(makeApp()).get(`/api/derivatives/binance/${SYMBOL}/funding`);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('un limit por encima del tope da 400', async () => {
      const response = await request(makeApp()).get(
        `/api/derivatives/binance/${SYMBOL}/funding?from=${START}&limit=5001`,
      );

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('un simbolo con forma invalida no llega al repositorio', async () => {
      const response = await request(makeApp()).get(
        `/api/derivatives/binance/xx';drop/funding?from=${START}`,
      );

      expect(response.status).toBe(400);
    });
  });
});
