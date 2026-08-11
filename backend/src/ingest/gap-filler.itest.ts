import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { timeframeToMs, type Candle, type Timeframe } from '@tt/shared';
import { runMigrations } from '../db/migrate.js';
import { createCandlesRepository, type CandlesRepository } from '../db/repositories/candles.repo.js';
import {
  createGapsRepository,
  NO_DATA_UPSTREAM,
  type GapsRepository,
} from '../db/repositories/gaps.repo.js';
import { createScratchDatabase, type ScratchDatabase } from '../testing/scratch-db.js';
import { fillGaps, retryDelayMs, type GapFillEvent } from './gap-filler.js';
import { scanGaps } from './gap-scanner.js';
import type { CandleFeed, CandleFeedQuery } from './backfill.js';

const SYMBOL = 'FILLUSDT';
const TIMEFRAME: Timeframe = '1m';
const STEP = timeframeToMs(TIMEFRAME);
const START = Date.UTC(2026, 6, 1, 0, 0, 0);
const TOTAL = 60;
const TO = START + TOTAL * STEP;

function makeCandle(index: number): Candle {
  const base = 64_000 + index;
  return { t: START + index * STEP, o: base, h: base + 10, l: base - 10, c: base + 5, v: 1 + index };
}

interface RecordingFeed extends CandleFeed {
  calls: CandleFeedQuery[];
}

function createFeed(available: readonly Candle[]): RecordingFeed {
  const ascending = [...available].sort((a, b) => a.t - b.t);
  const feed: RecordingFeed = {
    calls: [],
    async getHistoryCandles(query: CandleFeedQuery): Promise<Candle[]> {
      feed.calls.push(query);
      await Promise.resolve();
      const end = query.endTime ?? Number.POSITIVE_INFINITY;
      const limit = query.limit ?? 200;
      const before = ascending.filter((candle) => candle.t < end);
      return before.slice(Math.max(0, before.length - limit));
    },
  };
  return feed;
}

function createFailingFeed(message: string): RecordingFeed {
  const feed: RecordingFeed = {
    calls: [],
    async getHistoryCandles(query: CandleFeedQuery): Promise<Candle[]> {
      feed.calls.push(query);
      await Promise.resolve();
      throw new Error(message);
    },
  };
  return feed;
}

describe('fillGaps', () => {
  let db: ScratchDatabase;
  let candles: CandlesRepository;
  let gaps: GapsRepository;
  const waits: number[] = [];
  const noWait = async (ms: number): Promise<void> => {
    waits.push(ms);
    await Promise.resolve();
  };

  beforeAll(async () => {
    db = await createScratchDatabase({ applicationName: 'tt-itest-gap-fill' });
    await runMigrations({ pool: db.pool });
    candles = createCandlesRepository(db.pool);
    gaps = createGapsRepository(db.pool);
  });

  afterAll(async () => {
    await db.drop();
  });

  beforeEach(async () => {
    await db.pool.query('TRUNCATE candles');
    await db.pool.query('TRUNCATE ingest_gaps');
    waits.length = 0;
    await candles.upsertCandles({
      symbol: SYMBOL,
      timeframe: TIMEFRAME,
      source: 'ws',
      candles: Array.from({ length: TOTAL }, (_, index) => makeCandle(index)),
    });
  });

  async function deleteIndices(indices: readonly number[]): Promise<void> {
    await db.pool.query('DELETE FROM candles WHERE symbol = $1 AND ts = ANY($2::timestamptz[])', [
      SYMBOL,
      indices.map((index) => new Date(START + index * STEP)),
    ]);
  }

  async function scan(): Promise<void> {
    await scanGaps({
      pool: db.pool,
      series: [{ symbol: SYMBOL, timeframe: TIMEFRAME }],
      to: TO,
      windowMs: TOTAL * STEP,
    });
  }

  function fill(feed: CandleFeed, overrides: Partial<Parameters<typeof fillGaps>[0]> = {}) {
    return fillGaps({
      pool: db.pool,
      feed,
      symbol: SYMBOL,
      wait: noWait,
      ...overrides,
    });
  }

  async function storedIndices(): Promise<number[]> {
    const { rows } = await db.pool.query<{ ts: Date }>(
      'SELECT ts FROM candles WHERE symbol = $1 ORDER BY ts ASC',
      [SYMBOL],
    );
    return rows.map((row) => (row.ts.getTime() - START) / STEP);
  }

  const upstream = Array.from({ length: TOTAL }, (_, index) => makeCandle(index));

  it('recupera las velas del hueco y lo marca como relleno', async () => {
    await deleteIndices([20, 21, 22]);
    await scan();

    const report = await fill(createFeed(upstream));

    expect(report.filled).toBe(1);
    expect(report.failed).toBe(0);
    expect(report.results[0]).toMatchObject({
      fromTs: START + 20 * STEP,
      toTs: START + 22 * STEP,
      attempts: 1,
      stillMissing: 0,
      outcome: 'filled',
      error: null,
    });

    expect(await storedIndices()).toEqual(Array.from({ length: TOTAL }, (_, index) => index));

    const { rows } = await db.pool.query<{ filled_at: Date | null; last_error: string | null }>(
      'SELECT filled_at, last_error FROM ingest_gaps WHERE symbol = $1',
      [SYMBOL],
    );
    expect(rows[0]?.filled_at).toBeInstanceOf(Date);
    expect(rows[0]?.last_error).toBeNull();
    expect(await gaps.listOpen({ symbol: SYMBOL, timeframe: TIMEFRAME })).toEqual([]);
  });

  it('un hueco sin datos upstream se cierra con no-data-upstream y no se reintenta', async () => {
    await deleteIndices([20, 21, 22]);
    await scan();

    const feed = createFeed(upstream.filter((candle) => candle.t < START + 20 * STEP));
    const report = await fill(feed);

    expect(report.noData).toBe(1);
    expect(report.results[0]).toMatchObject({
      outcome: 'no-data-upstream',
      stillMissing: 3,
      error: NO_DATA_UPSTREAM,
    });
    expect(await storedIndices()).not.toContain(20);

    const again = await fill(feed);
    expect(again.results).toEqual([]);

    const { rows } = await db.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM ingest_gaps WHERE symbol = $1',
      [SYMBOL],
    );
    expect(rows[0]?.count).toBe('1');
  });

  it('un hueco cerrado como no-data-upstream tampoco lo reabre el scanner: sin bucle infinito', async () => {
    await deleteIndices([20, 21, 22]);

    for (let round = 0; round < 4; round += 1) {
      await scan();
      await fill(createFeed(upstream.filter((candle) => candle.t < START + 20 * STEP)));
    }

    const { rows } = await db.pool.query<{ count: string; attempts: number }>(
      'SELECT count(*)::text AS count, max(attempts) AS attempts FROM ingest_gaps WHERE symbol = $1',
      [SYMBOL],
    );
    expect(rows[0]?.count).toBe('1');
    expect(rows[0]?.attempts).toBe(1);
  });

  it('un relleno parcial cierra el hueco y anota que el resto no esta upstream', async () => {
    await deleteIndices([20, 21, 22]);
    await scan();

    const feed = createFeed(upstream.filter((candle) => candle.t !== START + 21 * STEP));
    const report = await fill(feed);

    expect(report.results[0]).toMatchObject({ outcome: 'partial', stillMissing: 1 });
    expect(await storedIndices()).toContain(20);
    expect(await storedIndices()).toContain(22);
    expect(await storedIndices()).not.toContain(21);
    expect(await gaps.listOpen({ symbol: SYMBOL, timeframe: TIMEFRAME })).toEqual([]);
  });

  describe('errores y reintentos', () => {
    it('un fallo del REST deja el hueco abierto y anota attempts y last_error', async () => {
      await deleteIndices([20, 21, 22]);
      await scan();

      const report = await fill(createFailingFeed('502 Bad Gateway'));

      expect(report.failed).toBe(1);
      expect(report.results[0]).toMatchObject({
        outcome: 'failed',
        attempts: 1,
        error: '502 Bad Gateway',
      });

      const open = await gaps.listOpen({ symbol: SYMBOL, timeframe: TIMEFRAME });
      expect(open).toHaveLength(1);
      expect(open[0]).toMatchObject({ attempts: 1, lastError: '502 Bad Gateway', filledAt: null });
    });

    it('un fallo que no es un Error se anota igual con su texto', async () => {
      await deleteIndices([20, 21, 22]);
      await scan();

      const rude: CandleFeed = {
        getHistoryCandles: (): Promise<Candle[]> =>
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          Promise.reject('el proxy corto la conexion'),
      };

      const report = await fill(rude);

      expect(report.results[0]).toMatchObject({
        outcome: 'failed',
        error: 'el proxy corto la conexion',
      });
      const open = await gaps.listOpen({ symbol: SYMBOL, timeframe: TIMEFRAME });
      expect(open[0]?.lastError).toBe('el proxy corto la conexion');
    });

    it('deja de reintentar al llegar a maxAttempts', async () => {
      await deleteIndices([20, 21, 22]);
      await scan();

      const feed = createFailingFeed('502 Bad Gateway');
      for (let round = 0; round < 5; round += 1) await fill(feed, { maxAttempts: 5 });

      const open = await gaps.listOpen({ symbol: SYMBOL, timeframe: TIMEFRAME });
      expect(open[0]?.attempts).toBe(5);

      const extra = await fill(feed, { maxAttempts: 5 });
      expect(extra.results).toEqual([]);
      expect(feed.calls).toHaveLength(5);
    });

    it('espera un backoff creciente antes de cada reintento', async () => {
      await deleteIndices([20, 21, 22]);
      await scan();

      const feed = createFailingFeed('502 Bad Gateway');
      const events: GapFillEvent[] = [];
      for (let round = 0; round < 4; round += 1) {
        await fill(feed, { maxAttempts: 5, log: (event) => events.push(event) });
      }

      expect(waits).toEqual([1000, 2000, 4000]);
      expect(
        events
          .filter((event) => event.kind === 'wait')
          .map((event) => (event.kind === 'wait' ? event.attempts : -1)),
      ).toEqual([1, 2, 3]);
    });

    it('el backoff crece exponencialmente y tiene techo', () => {
      expect(retryDelayMs(0)).toBe(0);
      expect(retryDelayMs(1)).toBe(1000);
      expect(retryDelayMs(2)).toBe(2000);
      expect(retryDelayMs(3)).toBe(4000);
      expect(retryDelayMs(10)).toBe(60_000);
      expect(retryDelayMs(50)).toBe(60_000);
    });

    it('tras un fallo, el intento siguiente puede rellenarlo', async () => {
      await deleteIndices([20, 21, 22]);
      await scan();

      await fill(createFailingFeed('502 Bad Gateway'));
      const report = await fill(createFeed(upstream));

      expect(report.filled).toBe(1);
      expect(report.results[0]?.attempts).toBe(2);
      expect(await storedIndices()).toEqual(Array.from({ length: TOTAL }, (_, index) => index));
    });
  });

  it('no se inventan velas: solo se escribe lo que devuelve el feed', async () => {
    await deleteIndices([20, 21, 22]);
    await scan();

    const feed = createFeed([]);
    await fill(feed);

    expect(await storedIndices()).not.toContain(20);
    expect(await storedIndices()).not.toContain(21);
    expect(await storedIndices()).not.toContain(22);
    expect(await storedIndices()).toHaveLength(TOTAL - 3);
  });

  it('el lote acota cuantos huecos se procesan por ejecucion', async () => {
    await deleteIndices([10, 20, 30, 40]);
    await scan();

    const feed = createFeed(upstream);
    const first = await fill(feed, { batch: 2 });
    expect(first.results).toHaveLength(2);

    const second = await fill(feed, { batch: 2 });
    expect(second.results).toHaveLength(2);

    expect(await gaps.listOpen({ symbol: SYMBOL, timeframe: TIMEFRAME })).toEqual([]);
    expect(await storedIndices()).toEqual(Array.from({ length: TOTAL }, (_, index) => index));
  });
});
