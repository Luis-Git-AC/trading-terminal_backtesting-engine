import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FundingRate, OpenInterestPoint } from '@tt/shared';
import { runMigrations } from '../db/migrate.js';
import { createDerivativesRepository } from '../db/repositories/derivatives.repo.js';
import { createScratchDatabase, type ScratchDatabase } from '../testing/scratch-db.js';
import { collectDerivatives } from './derivatives-collector.js';
import type { DerivativesHistoryQuery, ExchangeDerivativesClient } from './exchange/adapter.js';

const SYMBOL = 'XAUUSDT';
const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);

interface FakeClient extends ExchangeDerivativesClient {
  readonly fundingCalls: DerivativesHistoryQuery[];
  readonly oiCalls: DerivativesHistoryQuery[];
}

function fakeClient(rates: FundingRate[], history: OpenInterestPoint[], current: OpenInterestPoint): FakeClient {
  const fundingCalls: DerivativesHistoryQuery[] = [];
  const oiCalls: DerivativesHistoryQuery[] = [];

  return {
    fundingCalls,
    oiCalls,
    getFundingHistory: (query) => {
      fundingCalls.push(query);
      const from = query.startTime ?? Number.NEGATIVE_INFINITY;
      return Promise.resolve(rates.filter((rate) => rate.t >= from));
    },
    getOpenInterestHistory: (query) => {
      oiCalls.push(query);
      const from = query.startTime ?? Number.NEGATIVE_INFINITY;
      return Promise.resolve(history.filter((point) => point.t >= from));
    },
    getOpenInterest: () => Promise.resolve(current),
  };
}

const RATES: FundingRate[] = [
  { t: NOW - 8 * HOUR, rate: 0.0001, intervalHours: 4 },
  { t: NOW - 4 * HOUR, rate: 0.00012, intervalHours: 4 },
];

const OI_HISTORY: OpenInterestPoint[] = [
  { t: NOW - 2 * HOUR, base: 200_000, quote: 800_000_000 },
  { t: NOW - HOUR, base: 201_000, quote: 804_000_000 },
];

const OI_CURRENT: OpenInterestPoint = { t: NOW - 60_000, base: 202_000, quote: null };

describe('collectDerivatives', () => {
  let db: ScratchDatabase;

  beforeAll(async () => {
    db = await createScratchDatabase({ applicationName: 'tt-itest-derivatives-collector' });
    await runMigrations({ pool: db.pool });
  });

  afterAll(async () => {
    await db.drop();
  });

  beforeEach(async () => {
    await db.pool.query('DELETE FROM funding_rates');
    await db.pool.query('DELETE FROM open_interest');
  });

  it('persiste funding y OI del mercado, con el OI actual incluido', async () => {
    const client = fakeClient(RATES, OI_HISTORY, OI_CURRENT);

    const report = await collectDerivatives({
      pool: db.pool,
      client,
      exchange: 'binance',
      symbols: [SYMBOL],
      now: () => NOW,
    });

    expect(report.funding).toBe(2);
    expect(report.openInterest).toBe(3);
    expect(report.failed).toBe(0);

    const repo = createDerivativesRepository(db.pool);
    const stored = await repo.getFundingRates({
      exchange: 'binance',
      symbol: SYMBOL,
      from: NOW - 24 * HOUR,
      to: NOW,
    });
    expect(stored.map((rate) => rate.intervalHours)).toEqual([4, 4]);

    const oi = await repo.getOpenInterest({
      exchange: 'binance',
      symbol: SYMBOL,
      from: NOW - 24 * HOUR,
      to: NOW,
    });
    expect(oi.map((point) => point.t)).toEqual([
      NOW - 2 * HOUR,
      NOW - HOUR,
      NOW - 60_000,
    ]);
    expect(oi[2]?.quote).toBeNull();
  });

  it('repetir la recogida no duplica ni escribe filas', async () => {
    const client = fakeClient(RATES, OI_HISTORY, OI_CURRENT);
    const run = (): Promise<unknown> =>
      collectDerivatives({
        pool: db.pool,
        client,
        exchange: 'binance',
        symbols: [SYMBOL],
        now: () => NOW,
      });

    await run();
    const second = (await run()) as { funding: number; openInterest: number };

    expect(second.funding).toBe(0);
    expect(second.openInterest).toBe(0);

    const { rows } = await db.pool.query<{ funding: string; oi: string }>(
      `SELECT (SELECT count(*)::text FROM funding_rates) AS funding,
              (SELECT count(*)::text FROM open_interest) AS oi`,
    );
    expect(rows[0]).toEqual({ funding: '2', oi: '3' });
  });

  it('la segunda pasada reanuda desde el ultimo ts guardado, no desde el lookback', async () => {
    const client = fakeClient(RATES, OI_HISTORY, OI_CURRENT);
    const options = {
      pool: db.pool,
      client,
      exchange: 'binance',
      symbols: [SYMBOL],
      now: () => NOW,
    };

    await collectDerivatives(options);
    await collectDerivatives(options);

    expect(client.fundingCalls[0]?.startTime).toBe(NOW - 7 * 24 * HOUR);
    expect(client.fundingCalls[1]?.startTime).toBe(NOW - 4 * HOUR + 1);
    expect(client.oiCalls[1]?.startTime).toBe(NOW - 60_000 + 1);
  });

  it('un mercado que falla no detiene a los demas', async () => {
    const client: ExchangeDerivativesClient = {
      getFundingHistory: (query) =>
        query.symbol === 'ROTO'
          ? Promise.reject(new Error('el exchange devolvio 500'))
          : Promise.resolve(RATES),
      getOpenInterestHistory: () => Promise.resolve(OI_HISTORY),
      getOpenInterest: () => Promise.resolve(OI_CURRENT),
    };

    const report = await collectDerivatives({
      pool: db.pool,
      client,
      exchange: 'binance',
      symbols: ['ROTO', SYMBOL],
      now: () => NOW,
    });

    expect(report.failed).toBe(1);
    expect(report.results[0]?.error).toMatch(/500/);
    expect(report.results[1]?.funding).toBe(2);
    expect(report.funding).toBe(2);
  });
});
