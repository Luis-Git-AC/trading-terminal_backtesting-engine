import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { expectedCandleCount, timeframeToMs, type Candle, type Timeframe } from '@tt/shared';
import { runMigrations } from '../db/migrate.js';
import { createCandlesRepository, type CandlesRepository } from '../db/repositories/candles.repo.js';
import {
  createIngestStateRepository,
  type IngestStateRepository,
} from '../db/repositories/ingest-state.repo.js';
import { createScratchDatabase, type ScratchDatabase } from '../testing/scratch-db.js';
import { backfillSeries, type CandleFeed, type CandleFeedQuery } from './backfill.js';

const SYMBOL = 'BTCUSDT';
const TIMEFRAME: Timeframe = '1h';
const STEP = timeframeToMs(TIMEFRAME);
const START = Date.UTC(2026, 5, 1, 0, 0, 0);
const HOURS = 72;
const UPPER = START + HOURS * STEP;
const PAGE = 10;

function makeSeries(count: number, from = START): Candle[] {
  return Array.from({ length: count }, (_, index) => {
    const base = 60_000 + index;
    return { t: from + index * STEP, o: base, h: base + 10, l: base - 10, c: base + 5, v: 1 };
  });
}

interface FakeFeed extends CandleFeed {
  calls: CandleFeedQuery[];
  maxConcurrent: number;
}

function createFeed(available: readonly Candle[]): FakeFeed {
  const ascending = [...available].sort((a, b) => a.t - b.t);
  let active = 0;

  const feed: FakeFeed = {
    calls: [],
    maxConcurrent: 0,
    async getHistoryCandles(query: CandleFeedQuery): Promise<Candle[]> {
      feed.calls.push(query);
      active += 1;
      feed.maxConcurrent = Math.max(feed.maxConcurrent, active);
      try {
        await Promise.resolve();
        const end = query.endTime ?? Number.POSITIVE_INFINITY;
        const limit = query.limit ?? PAGE;
        const before = ascending.filter((candle) => candle.t < end);
        return before.slice(Math.max(0, before.length - limit));
      } finally {
        active -= 1;
      }
    },
  };

  return feed;
}

describe('backfillSeries', () => {
  let db: ScratchDatabase;
  let candles: CandlesRepository;
  let state: IngestStateRepository;

  beforeAll(async () => {
    db = await createScratchDatabase({ applicationName: 'tt-itest-backfill' });
    await runMigrations({ pool: db.pool });
    candles = createCandlesRepository(db.pool);
    state = createIngestStateRepository(db.pool);
  });

  afterAll(async () => {
    await db.drop();
  });

  beforeEach(async () => {
    await db.pool.query('DELETE FROM candles');
    await db.pool.query('DELETE FROM ingest_state');
  });

  const series = { symbol: SYMBOL, timeframe: TIMEFRAME };

  it('rellena el rango completo sin dejar huecos', async () => {
    const feed = createFeed(makeSeries(HOURS));

    const report = await backfillSeries({
      pool: db.pool,
      feed,
      ...series,
      from: START,
      to: UPPER,
      pageLimit: PAGE,
    });

    expect(report.done).toBe(true);
    expect(report.stoppedBy).toBe('target-reached');
    expect(report.upserted).toBe(HOURS);

    const coverage = await candles.getCoverage(series);
    expect(coverage).toEqual({
      fromTs: START,
      toTs: UPPER - STEP,
      rows: expectedCandleCount(START, UPPER, TIMEFRAME),
    });
    await expect(candles.findGaps({ ...series, from: START, to: UPPER })).resolves.toEqual([]);
  });

  it('pagina hacia atras: cada peticion pide lo anterior al cursor', async () => {
    const feed = createFeed(makeSeries(HOURS));

    await backfillSeries({
      pool: db.pool,
      feed,
      ...series,
      from: START,
      to: UPPER,
      pageLimit: PAGE,
    });

    const endTimes = feed.calls.map((call) => call.endTime);
    expect(endTimes[0]).toBe(UPPER);
    expect(endTimes).toEqual([...endTimes].sort((a, b) => (b ?? 0) - (a ?? 0)));
    expect(feed.calls.every((call) => call.limit === PAGE)).toBe(true);
  });

  it('no dispara peticiones en paralelo', async () => {
    const feed = createFeed(makeSeries(HOURS));

    await backfillSeries({
      pool: db.pool,
      feed,
      ...series,
      from: START,
      to: UPPER,
      pageLimit: PAGE,
    });

    expect(feed.maxConcurrent).toBe(1);
    expect(feed.calls.length).toBeGreaterThan(1);
  });

  it('no escribe velas por debajo del objetivo', async () => {
    const feed = createFeed(makeSeries(HOURS));
    const target = START + 40 * STEP;

    await backfillSeries({
      pool: db.pool,
      feed,
      ...series,
      from: target,
      to: UPPER,
      pageLimit: PAGE,
    });

    const coverage = await candles.getCoverage(series);
    expect(coverage.fromTs).toBe(target);
    expect(coverage.rows).toBe(expectedCandleCount(target, UPPER, TIMEFRAME));
  });

  describe('reanudacion', () => {
    it('continua desde el cursor y no duplica nada', async () => {
      const feed = createFeed(makeSeries(HOURS));

      const first = await backfillSeries({
        pool: db.pool,
        feed,
        ...series,
        from: START,
        to: UPPER,
        pageLimit: PAGE,
        maxPages: 3,
      });

      expect(first.done).toBe(false);
      expect(first.stoppedBy).toBe('max-pages');
      expect(first.upserted).toBe(3 * PAGE);

      const cursor = await state.get(series);
      expect(cursor?.backfillCursorTs).toBe(UPPER - 3 * PAGE * STEP);
      expect(cursor?.backfillDone).toBe(false);

      const resumed = createFeed(makeSeries(HOURS));
      const second = await backfillSeries({
        pool: db.pool,
        feed: resumed,
        ...series,
        from: START,
        to: UPPER,
        pageLimit: PAGE,
      });

      expect(second.startedFromTs).toBe(UPPER - 3 * PAGE * STEP);
      expect(second.done).toBe(true);
      expect(resumed.calls[0]?.endTime).toBe(UPPER - 3 * PAGE * STEP);

      const coverage = await candles.getCoverage(series);
      expect(coverage.rows).toBe(HOURS);
      expect(first.upserted + second.upserted).toBe(HOURS);
    });

    it('relanzarlo ya terminado no pide nada y sigue diciendo que esta hecho', async () => {
      const first = await backfillSeries({
        pool: db.pool,
        feed: createFeed(makeSeries(HOURS)),
        ...series,
        from: START,
        to: UPPER,
        pageLimit: PAGE,
      });
      expect(first.done).toBe(true);

      const again = createFeed(makeSeries(HOURS));
      const second = await backfillSeries({
        pool: db.pool,
        feed: again,
        ...series,
        from: START,
        to: UPPER,
        pageLimit: PAGE,
      });

      expect(again.calls).toEqual([]);
      expect(second).toMatchObject({ pages: 0, fetched: 0, upserted: 0, done: true });
      expect(second.reachedTs).toBe(START);
      expect((await state.get(series))?.backfillDone).toBe(true);
      expect((await candles.getCoverage(series)).rows).toBe(HOURS);
    });

    it('anuncia que esta reanudando', async () => {
      const events: string[] = [];
      const feed = createFeed(makeSeries(HOURS));

      await backfillSeries({
        pool: db.pool,
        feed,
        ...series,
        from: START,
        to: UPPER,
        pageLimit: PAGE,
        maxPages: 1,
        log: (event) => {
          if (event.kind === 'start') events.push(`start resumed=${String(event.resumed)}`);
        },
      });

      await backfillSeries({
        pool: db.pool,
        feed: createFeed(makeSeries(HOURS)),
        ...series,
        from: START,
        to: UPPER,
        pageLimit: PAGE,
        maxPages: 1,
        log: (event) => {
          if (event.kind === 'start') events.push(`start resumed=${String(event.resumed)}`);
        },
      });

      expect(events).toEqual(['start resumed=false', 'start resumed=true']);
    });

    it('el cursor y las velas viajan juntos: si el upsert falla, el cursor no avanza', async () => {
      const broken = makeSeries(HOURS);
      const index = HOURS - 15;
      const original = broken[index];
      if (original === undefined) expect.unreachable(`no hay vela en el indice ${index}`);
      broken[index] = { ...original, h: 1, l: 99_999 };

      const feed = createFeed(broken);

      await expect(
        backfillSeries({
          pool: db.pool,
          feed,
          ...series,
          from: START,
          to: UPPER,
          pageLimit: PAGE,
        }),
      ).rejects.toThrow();

      const coverage = await candles.getCoverage(series);
      expect(coverage.rows).toBe(PAGE);

      const cursor = await state.get(series);
      expect(cursor?.backfillCursorTs).toBe(UPPER - PAGE * STEP);
      expect(cursor?.backfillDone).toBe(false);
    });
  });

  describe('fin del historico del exchange', () => {
    it('una pagina vacia antes del objetivo marca backfill_done sin lanzar', async () => {
      const availableFrom = START + 24 * STEP;
      const feed = createFeed(makeSeries(HOURS - 24, availableFrom));

      const report = await backfillSeries({
        pool: db.pool,
        feed,
        ...series,
        from: START,
        to: UPPER,
        pageLimit: PAGE,
      });

      expect(report.stoppedBy).toBe('no-more-data');
      expect(report.done).toBe(true);
      expect(report.reachedTs).toBe(availableFrom);

      const cursor = await state.get(series);
      expect(cursor?.backfillDone).toBe(true);
      expect(cursor?.backfillCursorTs).toBe(availableFrom);

      const coverage = await candles.getCoverage(series);
      expect(coverage.fromTs).toBe(availableFrom);
      expect(coverage.rows).toBe(HOURS - 24);
    });

    it('un feed completamente vacio termina sin escribir nada y sin error', async () => {
      const report = await backfillSeries({
        pool: db.pool,
        feed: createFeed([]),
        ...series,
        from: START,
        to: UPPER,
        pageLimit: PAGE,
      });

      expect(report).toMatchObject({ pages: 1, fetched: 0, upserted: 0, done: true });
      expect(report.stoppedBy).toBe('no-more-data');
      expect((await candles.getCoverage(series)).rows).toBe(0);
    });
  });

  describe('progreso', () => {
    it('informa cada N paginas con velas/s y ETA', async () => {
      const feed = createFeed(makeSeries(HOURS));
      const progress: { pages: number; remaining: number; etaMs: number | null }[] = [];

      await backfillSeries({
        pool: db.pool,
        feed,
        ...series,
        from: START,
        to: UPPER,
        pageLimit: PAGE,
        progressEveryPages: 3,
        log: (event) => {
          if (event.kind === 'progress') {
            progress.push({ pages: event.pages, remaining: event.remaining, etaMs: event.etaMs });
          }
        },
      });

      expect(progress.map((entry) => entry.pages)).toEqual([3, 6]);
      expect(progress.map((entry) => entry.remaining)).toEqual([HOURS - 30, HOURS - 60]);
      expect(progress.every((entry) => entry.etaMs !== null)).toBe(true);
    });

    it('el informe final cuadra con lo que hay en la base de datos', async () => {
      const feed = createFeed(makeSeries(HOURS));

      const report = await backfillSeries({
        pool: db.pool,
        feed,
        ...series,
        from: START,
        to: UPPER,
        pageLimit: PAGE,
      });

      expect(report.pages).toBe(Math.ceil(HOURS / PAGE));
      expect(report.fetched).toBe(HOURS);
      expect(report.upserted).toBe((await candles.getCoverage(series)).rows);
      expect(report.reachedTs).toBe(START);
    });
  });
});
