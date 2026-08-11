import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { timeframeToMs, type Candle, type Timeframe } from '@tt/shared';
import { runMigrations } from '../db/migrate.js';
import { createCandlesRepository, type CandlesRepository } from '../db/repositories/candles.repo.js';
import { createScratchDatabase, type ScratchDatabase } from '../testing/scratch-db.js';
import { createBitgetRestClient, type HttpResponse } from './exchange/bitget/rest.js';
import { reconcileSeries } from './reconcile.js';

const SYMBOL = 'AVALUSDT';
const TIMEFRAME: Timeframe = '1m';
const STEP = timeframeToMs(TIMEFRAME);
const START = Date.UTC(2026, 6, 1, 0, 0, 0);
const DAY_CANDLES = 1440;
const PAGE_LIMIT = 200;
const RPS = 5;
const TIMER_SLOP_MS = 25;

function makeRow(index: number): string[] {
  const base = 64_000 + index;
  return [
    String(START + index * STEP),
    String(base),
    String(base + 10),
    String(base - 10),
    String(base + 5),
    '1.5',
    '96000',
    '96000',
  ];
}

interface FakeHttp {
  calls: { url: string; at: number }[];
  fetch: (url: string) => Promise<HttpResponse>;
}

function createHttp(available: number): FakeHttp {
  const calls: { url: string; at: number }[] = [];

  return {
    calls,
    fetch: (url: string): Promise<HttpResponse> => {
      calls.push({ url, at: Date.now() });

      const parsed = new URL(url);
      const endTime = Number(parsed.searchParams.get('endTime'));
      const limit = Number(parsed.searchParams.get('limit'));

      const lastIndex = Math.min(available - 1, Math.floor((endTime - START) / STEP) - 1);
      const firstIndex = Math.max(0, lastIndex - limit + 1);
      const rows =
        lastIndex < 0
          ? []
          : Array.from({ length: lastIndex - firstIndex + 1 }, (_, offset) =>
              makeRow(firstIndex + offset),
            );

      return Promise.resolve({
        status: 200,
        headers: { get: () => null },
        json: () => Promise.resolve({ code: '00000', msg: 'success', requestTime: 0, data: rows }),
      });
    },
  };
}

describe('proteccion contra avalancha tras una reconexion larga', () => {
  let db: ScratchDatabase;
  let candles: CandlesRepository;

  beforeAll(async () => {
    db = await createScratchDatabase({ applicationName: 'tt-itest-avalanche' });
    await runMigrations({ pool: db.pool });
    candles = createCandlesRepository(db.pool);
  });

  afterAll(async () => {
    await db.drop();
  });

  beforeEach(async () => {
    await db.pool.query('TRUNCATE candles');
  });

  async function storedCount(): Promise<number> {
    const { rows } = await db.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM candles WHERE symbol = $1',
      [SYMBOL],
    );
    return Number(rows[0]?.count ?? '0');
  }

  it('un hueco de 24 h en 1m se pagina y respeta BACKFILL_RPS sin rafagas', async () => {
    await candles.upsertCandles({
      symbol: SYMBOL,
      timeframe: TIMEFRAME,
      source: 'ws',
      candles: [
        {
          t: START,
          o: 64_000,
          h: 64_010,
          l: 63_990,
          c: 64_005,
          v: 1,
        } satisfies Candle,
      ],
    });

    const http = createHttp(DAY_CANDLES);
    const client = createBitgetRestClient({
      baseUrl: 'https://exchange.local',
      pageLimit: PAGE_LIMIT,
      rps: RPS,
      fetch: http.fetch,
    });

    const report = await reconcileSeries({
      pool: db.pool,
      feed: client,
      symbol: SYMBOL,
      timeframe: TIMEFRAME,
      to: START + DAY_CANDLES * STEP,
      pageLimit: PAGE_LIMIT,
      maxPages: 20,
    });

    expect(report.missingBefore).toBe(DAY_CANDLES - 1);
    expect(report.stoppedBy).toBe('complete');
    expect(await storedCount()).toBe(DAY_CANDLES);

    const expectedPages = Math.ceil((DAY_CANDLES - 1) / PAGE_LIMIT);
    expect(http.calls).toHaveLength(expectedPages);

    const first = http.calls[0]?.at ?? 0;
    const offsets = http.calls.map((call) => call.at - first);
    const minGapMs = 1000 / RPS;

    for (const [index, offset] of offsets.entries()) {
      const earliest = index * minGapMs - TIMER_SLOP_MS;
      expect(
        { index, onTime: offset >= earliest },
        `la pagina ${index} salio a los ${offset} ms, no podia salir antes de ${earliest}`,
      ).toEqual({ index, onTime: true });
    }

    const total = offsets[offsets.length - 1] ?? 0;
    const minTotal = (expectedPages - 1) * minGapMs - TIMER_SLOP_MS;
    expect(
      { spread: total >= minTotal },
      `las ${expectedPages} paginas ocuparon ${total} ms, se esperaban >= ${minTotal}`,
    ).toEqual({ spread: true });
  });

  it('ninguna pagina pide mas velas de las que admite el exchange', async () => {
    await candles.upsertCandles({
      symbol: SYMBOL,
      timeframe: TIMEFRAME,
      source: 'ws',
      candles: [{ t: START, o: 64_000, h: 64_010, l: 63_990, c: 64_005, v: 1 }],
    });

    const http = createHttp(DAY_CANDLES);
    const client = createBitgetRestClient({
      baseUrl: 'https://exchange.local',
      pageLimit: PAGE_LIMIT,
      rps: RPS,
      fetch: http.fetch,
    });

    await reconcileSeries({
      pool: db.pool,
      feed: client,
      symbol: SYMBOL,
      timeframe: TIMEFRAME,
      to: START + DAY_CANDLES * STEP,
      pageLimit: PAGE_LIMIT,
      maxPages: 20,
    });

    const limits = http.calls.map((call) => Number(new URL(call.url).searchParams.get('limit')));
    expect(limits.every((limit) => limit <= 200)).toBe(true);
    expect(new Set(limits)).toEqual(new Set([PAGE_LIMIT]));
  });

  it('si el hueco no cabe en el tope de paginas se delega, sin pedir una sola pagina', async () => {
    await candles.upsertCandles({
      symbol: SYMBOL,
      timeframe: TIMEFRAME,
      source: 'ws',
      candles: [{ t: START, o: 64_000, h: 64_010, l: 63_990, c: 64_005, v: 1 }],
    });

    const http = createHttp(DAY_CANDLES);
    const client = createBitgetRestClient({
      baseUrl: 'https://exchange.local',
      pageLimit: PAGE_LIMIT,
      rps: RPS,
      fetch: http.fetch,
    });

    const report = await reconcileSeries({
      pool: db.pool,
      feed: client,
      symbol: SYMBOL,
      timeframe: TIMEFRAME,
      to: START + DAY_CANDLES * STEP,
      pageLimit: PAGE_LIMIT,
      maxPages: 3,
    });

    expect(report.stoppedBy).toBe('gap-too-large');
    expect(report.missingBefore).toBe(DAY_CANDLES - 1);
    expect(http.calls).toEqual([]);
    expect(await storedCount()).toBe(1);
    expect(report.gap).toEqual({
      fromTs: START + STEP,
      toTs: START + (DAY_CANDLES - 1) * STEP,
    });
  });

  it('con el tope justo por encima del hueco, se reconcilia entero sin delegar', async () => {
    await candles.upsertCandles({
      symbol: SYMBOL,
      timeframe: TIMEFRAME,
      source: 'ws',
      candles: [{ t: START, o: 64_000, h: 64_010, l: 63_990, c: 64_005, v: 1 }],
    });

    const http = createHttp(DAY_CANDLES);
    const client = createBitgetRestClient({
      baseUrl: 'https://exchange.local',
      pageLimit: PAGE_LIMIT,
      rps: 1000,
      fetch: http.fetch,
    });

    const report = await reconcileSeries({
      pool: db.pool,
      feed: client,
      symbol: SYMBOL,
      timeframe: TIMEFRAME,
      to: START + DAY_CANDLES * STEP,
      pageLimit: PAGE_LIMIT,
      maxPages: 8,
    });

    expect(report.stoppedBy).toBe('complete');
    expect(report.pages).toBe(8);
    expect(await storedCount()).toBe(DAY_CANDLES);
  });
});
