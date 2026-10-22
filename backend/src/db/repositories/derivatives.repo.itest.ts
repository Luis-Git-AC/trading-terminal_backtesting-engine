import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../migrate.js';
import { createScratchDatabase, type ScratchDatabase } from '../../testing/scratch-db.js';
import {
  MAX_DERIVATIVES_LIMIT,
  createDerivativesRepository,
  type DerivativesRepository,
  type FundingRate,
  type OpenInterestPoint,
} from './derivatives.repo.js';

const SYMBOL = 'XAUUSDT';
const START = Date.UTC(2026, 3, 1, 0, 0, 0);
const FOUR_HOURS = 4 * 60 * 60 * 1000;

function makeFunding(count: number, from = START, step = FOUR_HOURS): FundingRate[] {
  return Array.from({ length: count }, (_, index) => ({
    t: from + index * step,
    rate: 0.0001 + index / 1_000_000,
    intervalHours: 4,
  }));
}

function makeOpenInterest(count: number, from = START, step = FOUR_HOURS): OpenInterestPoint[] {
  return Array.from({ length: count }, (_, index) => ({
    t: from + index * step,
    base: 200_000 + index,
    quote: (200_000 + index) * 4000,
  }));
}

async function countRows(db: ScratchDatabase, table: string): Promise<number> {
  const { rows } = await db.pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ${table}`,
  );
  return Number(rows[0]?.count ?? 0);
}

describe('derivatives.repo', () => {
  let db: ScratchDatabase;
  let repo: DerivativesRepository;

  beforeAll(async () => {
    db = await createScratchDatabase({ applicationName: 'tt-itest-derivatives-repo' });
    await runMigrations({ pool: db.pool });
    repo = createDerivativesRepository(db.pool);
  });

  afterAll(async () => {
    await db.drop();
  });

  beforeEach(async () => {
    await db.pool.query('DELETE FROM funding_rates');
    await db.pool.query('DELETE FROM open_interest');
  });

  describe('funding', () => {
    it('inserta un rango y lo devuelve en orden con su periodo', async () => {
      const inserted = await repo.upsertFundingRates({
        exchange: 'binance',
        symbol: SYMBOL,
        source: 'rest',
        rates: makeFunding(6),
      });

      expect(inserted).toBe(6);

      const rates = await repo.getFundingRates({
        exchange: 'binance',
        symbol: SYMBOL,
        from: START,
        to: START + 6 * FOUR_HOURS,
      });

      expect(rates).toHaveLength(6);
      expect(rates.map((rate) => rate.t)).toEqual(makeFunding(6).map((rate) => rate.t));
      expect(rates.every((rate) => rate.intervalHours === 4)).toBe(true);
      expect(rates[0]?.rate).toBeCloseTo(0.0001, 10);
    });

    it('repetir la recogida no escribe ninguna fila la segunda vez', async () => {
      const rates = makeFunding(50);
      const first = await repo.upsertFundingRates({
        exchange: 'binance',
        symbol: SYMBOL,
        source: 'rest',
        rates,
      });
      const second = await repo.upsertFundingRates({
        exchange: 'binance',
        symbol: SYMBOL,
        source: 'rest',
        rates,
      });

      expect(first).toBe(50);
      expect(second).toBe(0);
      expect(await countRows(db, 'funding_rates')).toBe(50);
    });

    it('una tasa corregida por el exchange sobrescribe la fila sin duplicarla', async () => {
      await repo.upsertFundingRates({
        exchange: 'binance',
        symbol: SYMBOL,
        source: 'rest',
        rates: makeFunding(1),
      });
      const changed = await repo.upsertFundingRates({
        exchange: 'binance',
        symbol: SYMBOL,
        source: 'ws',
        rates: [{ t: START, rate: 0.0009, intervalHours: 8 }],
      });

      expect(changed).toBe(1);
      expect(await countRows(db, 'funding_rates')).toBe(1);

      const [stored] = await repo.getFundingRates({
        exchange: 'binance',
        symbol: SYMBOL,
        from: START,
        to: START + FOUR_HOURS,
      });
      expect(stored?.rate).toBeCloseTo(0.0009, 10);
      expect(stored?.intervalHours).toBe(8);
    });

    it('el periodo distingue exchanges: el mismo ts con 4 h y con 1 h son filas distintas', async () => {
      await repo.upsertFundingRates({
        exchange: 'binance',
        symbol: SYMBOL,
        source: 'rest',
        rates: [{ t: START, rate: 0.0001, intervalHours: 4 }],
      });
      await repo.upsertFundingRates({
        exchange: 'hyperliquid',
        symbol: 'GOLD',
        source: 'rest',
        rates: [{ t: START, rate: 0.00001, intervalHours: 1 }],
      });

      expect(await countRows(db, 'funding_rates')).toBe(2);

      const hyperliquid = await repo.getFundingRates({
        exchange: 'hyperliquid',
        symbol: 'GOLD',
        from: START,
        to: START + FOUR_HOURS,
      });
      expect(hyperliquid).toHaveLength(1);
      expect(hyperliquid[0]?.intervalHours).toBe(1);
    });

    it('el rango es semiabierto y el limite esta acotado', async () => {
      await repo.upsertFundingRates({
        exchange: 'binance',
        symbol: SYMBOL,
        source: 'rest',
        rates: makeFunding(3),
      });

      const rates = await repo.getFundingRates({
        exchange: 'binance',
        symbol: SYMBOL,
        from: START,
        to: START + 2 * FOUR_HOURS,
        limit: Number.POSITIVE_INFINITY,
      });

      expect(rates.map((rate) => rate.t)).toEqual([START, START + FOUR_HOURS]);
      expect(MAX_DERIVATIVES_LIMIT).toBe(5000);
    });

    it('getLastFundingTs devuelve null sin datos y el maximo con datos', async () => {
      expect(await repo.getLastFundingTs({ exchange: 'binance', symbol: SYMBOL })).toBeNull();

      await repo.upsertFundingRates({
        exchange: 'binance',
        symbol: SYMBOL,
        source: 'rest',
        rates: makeFunding(3),
      });

      expect(await repo.getLastFundingTs({ exchange: 'binance', symbol: SYMBOL })).toBe(
        START + 2 * FOUR_HOURS,
      );
    });
  });

  describe('open interest', () => {
    it('persiste base y quote con el ts del exchange', async () => {
      const inserted = await repo.upsertOpenInterest({
        exchange: 'binance',
        symbol: SYMBOL,
        source: 'rest',
        points: makeOpenInterest(4),
      });

      expect(inserted).toBe(4);

      const points = await repo.getOpenInterest({
        exchange: 'binance',
        symbol: SYMBOL,
        from: START,
        to: START + 4 * FOUR_HOURS,
      });

      expect(points).toHaveLength(4);
      expect(points[0]?.t).toBe(START);
      expect(points[0]?.base).toBe(200_000);
      expect(points[0]?.quote).toBe(800_000_000);
    });

    it('repetir la recogida no escribe ninguna fila la segunda vez', async () => {
      const points = makeOpenInterest(30);
      const first = await repo.upsertOpenInterest({
        exchange: 'binance',
        symbol: SYMBOL,
        source: 'rest',
        points,
      });
      const second = await repo.upsertOpenInterest({
        exchange: 'binance',
        symbol: SYMBOL,
        source: 'rest',
        points,
      });

      expect(first).toBe(30);
      expect(second).toBe(0);
      expect(await countRows(db, 'open_interest')).toBe(30);
    });

    it('acepta el OI sin valor en quote', async () => {
      await repo.upsertOpenInterest({
        exchange: 'hyperliquid',
        symbol: 'BTC',
        source: 'ws',
        points: [{ t: START, base: 1234.5, quote: null }],
      });

      const [point] = await repo.getOpenInterest({
        exchange: 'hyperliquid',
        symbol: 'BTC',
        from: START,
        to: START + FOUR_HOURS,
      });

      expect(point?.base).toBe(1234.5);
      expect(point?.quote).toBeNull();
    });

    it('getLastOpenInterestTs devuelve el maximo por mercado', async () => {
      await repo.upsertOpenInterest({
        exchange: 'binance',
        symbol: SYMBOL,
        source: 'rest',
        points: makeOpenInterest(2),
      });

      expect(await repo.getLastOpenInterestTs({ exchange: 'binance', symbol: SYMBOL })).toBe(
        START + FOUR_HOURS,
      );
      expect(await repo.getLastOpenInterestTs({ exchange: 'binance', symbol: 'XAGUSDT' })).toBeNull();
    });
  });

  it('una lista vacia no toca la base de datos', async () => {
    expect(
      await repo.upsertFundingRates({ symbol: SYMBOL, source: 'rest', rates: [] }),
    ).toBe(0);
    expect(
      await repo.upsertOpenInterest({ symbol: SYMBOL, source: 'rest', points: [] }),
    ).toBe(0);
    expect(await countRows(db, 'funding_rates')).toBe(0);
    expect(await countRows(db, 'open_interest')).toBe(0);
  });
});
