import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FundingRate, OpenInterestPoint } from '@tt/shared';
import { runMigrations } from '../db/migrate.js';
import { createDerivativesRepository } from '../db/repositories/derivatives.repo.js';
import { createRateLimiter } from '../ingest/rate-limiter.js';
import { createScratchDatabase, type ScratchDatabase } from '../testing/scratch-db.js';
import { toRunnable, type SourceContext, type SourceRunReport } from './adapter.js';
import { createDerivativesSource, type DerivativesMarket } from './derivatives.source.js';
import type { DerivativesHistoryQuery, ExchangeDerivativesClient } from '../ingest/exchange/adapter.js';

const SYMBOL = 'XAUUSDT';
const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const SCHEDULE = '7 * * * *';

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

const CONTEXT: SourceContext = { limiter: createRateLimiter({ rps: 1000 }), now: () => NOW };

describe('fuente de derivados', () => {
  let db: ScratchDatabase;

  beforeAll(async () => {
    db = await createScratchDatabase({ applicationName: 'tt-itest-derivatives-source' });
    await runMigrations({ pool: db.pool });
  });

  afterAll(async () => {
    await db.drop();
  });

  beforeEach(async () => {
    await db.pool.query('DELETE FROM funding_rates');
    await db.pool.query('DELETE FROM open_interest');
  });

  function run(markets: readonly DerivativesMarket[], errors: unknown[] = []): Promise<SourceRunReport> {
    const source = createDerivativesSource({
      pool: db.pool,
      markets,
      schedule: SCHEDULE,
      onMarketError: (_market, error) => {
        errors.push(error);
      },
    });
    return toRunnable(source).run(null, CONTEXT);
  }

  it('persiste funding y OI del mercado, con el OI actual incluido', async () => {
    const client = fakeClient(RATES, OI_HISTORY, OI_CURRENT);

    const report = await run([{ exchange: 'binance', symbol: SYMBOL, client }]);

    expect(report.sourceId).toBe('derivatives');
    expect(report.items).toBe(5);
    expect(report.written).toBe(5);
    expect(report.discarded).toBe(0);

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
    expect(oi.map((point) => point.t)).toEqual([NOW - 2 * HOUR, NOW - HOUR, NOW - 60_000]);
    expect(oi[2]?.quote).toBeNull();
  });

  it('repetir la recogida no duplica ni escribe filas', async () => {
    const client = fakeClient(RATES, OI_HISTORY, OI_CURRENT);
    const markets = [{ exchange: 'binance', symbol: SYMBOL, client }];

    await run(markets);
    const second = await run(markets);

    // El funding si se reanuda y no vuelve a pedirse, pero `getOpenInterest` devuelve siempre el
    // snapshot actual: llega 1 elemento y se escriben 0 porque el upsert lo ve identico.
    expect(second.items).toBe(1);
    expect(second.written).toBe(0);
    expect(second.skipped).toBe(1);

    const { rows } = await db.pool.query<{ funding: string; oi: string }>(
      `SELECT (SELECT count(*)::text FROM funding_rates) AS funding,
              (SELECT count(*)::text FROM open_interest) AS oi`,
    );
    expect(rows[0]).toEqual({ funding: '2', oi: '3' });
  });

  it('la segunda pasada reanuda desde el ultimo ts guardado, no desde el lookback', async () => {
    const client = fakeClient(RATES, OI_HISTORY, OI_CURRENT);
    const markets = [{ exchange: 'binance', symbol: SYMBOL, client }];

    await run(markets);
    await run(markets);

    expect(client.fundingCalls[0]?.startTime).toBe(NOW - 7 * 24 * HOUR);
    expect(client.fundingCalls[1]?.startTime).toBe(NOW - 4 * HOUR + 1);
    expect(client.oiCalls[1]?.startTime).toBe(NOW - 60_000 + 1);
  });

  it('un mercado que falla no detiene a los demas', async () => {
    const roto: ExchangeDerivativesClient = {
      getFundingHistory: () => Promise.reject(new Error('el exchange devolvio 500')),
      getOpenInterestHistory: () => Promise.resolve(OI_HISTORY),
      getOpenInterest: () => Promise.resolve(OI_CURRENT),
    };
    const errors: unknown[] = [];

    const report = await run(
      [
        { exchange: 'binance', symbol: 'ROTO', client: roto },
        { exchange: 'binance', symbol: SYMBOL, client: fakeClient(RATES, OI_HISTORY, OI_CURRENT) },
      ],
      errors,
    );

    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toMatch(/500/);
    expect(report.items).toBe(5);
    expect(report.written).toBe(5);
  });

  it('descarta las filas con numeros imposibles y las cuenta', async () => {
    const client = fakeClient(
      [...RATES, { t: NOW - HOUR, rate: Number.NaN, intervalHours: 4 }],
      [...OI_HISTORY, { t: NOW - 3 * HOUR, base: -1, quote: null }],
      OI_CURRENT,
    );

    const report = await run([{ exchange: 'binance', symbol: SYMBOL, client }]);

    expect(report.discarded).toBe(2);
    expect(report.items).toBe(5);
    expect(report.written).toBe(5);
  });

  it('cada mercado va a su propia serie: dos exchanges no se pisan', async () => {
    const report = await run([
      { exchange: 'binance', symbol: SYMBOL, client: fakeClient(RATES, OI_HISTORY, OI_CURRENT) },
      { exchange: 'hyperliquid', symbol: 'BTC', client: fakeClient(RATES, OI_HISTORY, OI_CURRENT) },
    ]);

    expect(report.written).toBe(10);

    const { rows } = await db.pool.query<{ exchange: string; n: string }>(
      'SELECT exchange, count(*)::text AS n FROM funding_rates GROUP BY 1 ORDER BY 1',
    );
    expect(rows).toEqual([
      { exchange: 'binance', n: '2' },
      { exchange: 'hyperliquid', n: '2' },
    ]);
  });
});
