import type { Candle, Timeframe } from '@tt/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import {
  createCandlesRepository,
  MAX_CANDLES_LIMIT,
  type CandlesRepository,
} from '../db/repositories/candles.repo.js';
import { createScratchDatabase, type ScratchDatabase } from '../testing/scratch-db.js';
import {
  chunkSize,
  loadCandles,
  UnalignedCandleError,
  UnorderedCandleError,
} from './candle-loader.js';

const SYMBOL = 'LOADTEST';
const TIMEFRAME: Timeframe = '1m';
const STEP = 60_000;
const START = Date.UTC(2026, 0, 1);
const TOTAL = 12_000;

function makeCandle(index: number): Candle {
  const base = 100 + (index % 50);
  return { t: START + index * STEP, o: base, h: base + 1, l: base - 1, c: base + 0.5, v: 10 };
}

describe('candle-loader', () => {
  let db: ScratchDatabase;
  let candles: CandlesRepository;

  beforeAll(async () => {
    db = await createScratchDatabase({ applicationName: 'tt-itest-candle-loader' });
    await runMigrations({ pool: db.pool });
    candles = createCandlesRepository(db.pool);
  });

  afterAll(async () => {
    await db.drop();
  });

  beforeEach(async () => {
    await db.pool.query('TRUNCATE candles');
    await candles.upsertCandles({
      symbol: SYMBOL,
      timeframe: TIMEFRAME,
      source: 'rest',
      candles: Array.from({ length: TOTAL }, (_, index) => makeCandle(index)),
    });
  });

  it('carga el rango completo en orden aunque supere el limite por consulta', async () => {
    const loaded = await loadCandles({
      candles,
      symbol: SYMBOL,
      timeframe: TIMEFRAME,
      from: START,
      to: START + TOTAL * STEP,
    });

    expect(loaded).toHaveLength(TOTAL);
    expect(loaded[0]?.t).toBe(START);
    expect(loaded[TOTAL - 1]?.t).toBe(START + (TOTAL - 1) * STEP);
    for (let i = 1; i < loaded.length; i += 1) {
      expect(loaded[i]?.t).toBe((loaded[i - 1]?.t ?? 0) + STEP);
    }
  });

  it('pagina en trozos y nunca pide mas de MAX_CANDLES_LIMIT por consulta', async () => {
    const spy = vi.fn(candles.getCandles.bind(candles));
    const repo: CandlesRepository = { ...candles, getCandles: spy };

    const loaded = await loadCandles({
      candles: repo,
      symbol: SYMBOL,
      timeframe: TIMEFRAME,
      from: START,
      to: START + TOTAL * STEP,
      chunkBars: 50_000,
    });

    expect(loaded).toHaveLength(TOTAL);
    expect(spy.mock.calls.length).toBeGreaterThan(1);
    for (const [query] of spy.mock.calls) {
      expect(query.limit).toBeLessThanOrEqual(MAX_CANDLES_LIMIT);
    }
  });

  it('avisa del progreso una vez por trozo con el acumulado', async () => {
    const chunks: number[] = [];

    await loadCandles({
      candles,
      symbol: SYMBOL,
      timeframe: TIMEFRAME,
      from: START,
      to: START + TOTAL * STEP,
      chunkBars: 2_000,
      onChunk: (loaded) => {
        chunks.push(loaded);
      },
    });

    expect(chunks).toEqual([2_000, 4_000, 6_000, 8_000, 10_000, 12_000]);
  });

  it('el rango es semiabierto: no incluye la vela de to', async () => {
    const loaded = await loadCandles({
      candles,
      symbol: SYMBOL,
      timeframe: TIMEFRAME,
      from: START,
      to: START + 10 * STEP,
    });

    expect(loaded).toHaveLength(10);
    expect(loaded.at(-1)?.t).toBe(START + 9 * STEP);
  });

  it('un rango sin velas devuelve una lista vacia sin reventar', async () => {
    const loaded = await loadCandles({
      candles,
      symbol: SYMBOL,
      timeframe: TIMEFRAME,
      from: START + 100_000 * STEP,
      to: START + 100_100 * STEP,
    });

    expect(loaded).toEqual([]);
  });

  it('un hueco en medio no rompe la paginacion', async () => {
    await db.pool.query('DELETE FROM candles WHERE ts >= $1 AND ts < $2', [
      new Date(START + 5_000 * STEP),
      new Date(START + 5_010 * STEP),
    ]);

    const loaded = await loadCandles({
      candles,
      symbol: SYMBOL,
      timeframe: TIMEFRAME,
      from: START,
      to: START + TOTAL * STEP,
      chunkBars: 1_000,
    });

    expect(loaded).toHaveLength(TOTAL - 10);
  });

  it('una vela desalineada con el timeframe aborta la carga', async () => {
    await db.pool.query(
      `INSERT INTO candles (exchange, symbol, timeframe, ts, open, high, low, close, volume, source)
       VALUES ('bitget', $1, $2, $3, 1, 1, 1, 1, 1, 'rest')`,
      [SYMBOL, TIMEFRAME, new Date(START + 30_000)],
    );

    await expect(
      loadCandles({
        candles,
        symbol: SYMBOL,
        timeframe: TIMEFRAME,
        from: START,
        to: START + 100 * STEP,
      }),
    ).rejects.toBeInstanceOf(UnalignedCandleError);
  });

  it('una serie que no avanza aborta la carga', async () => {
    const repeated: Candle[] = [makeCandle(0), makeCandle(1), makeCandle(1)];
    const repo: CandlesRepository = {
      ...candles,
      getCandles: () => Promise.resolve(repeated),
    };

    await expect(
      loadCandles({
        candles: repo,
        symbol: SYMBOL,
        timeframe: TIMEFRAME,
        from: START,
        to: START + 10 * STEP,
        chunkBars: 10,
      }),
    ).rejects.toBeInstanceOf(UnorderedCandleError);
  });

  it('chunkSize acota entre 1 y el maximo del repositorio', () => {
    expect(chunkSize(undefined)).toBe(MAX_CANDLES_LIMIT);
    expect(chunkSize(50_000)).toBe(MAX_CANDLES_LIMIT);
    expect(chunkSize(1_000)).toBe(1_000);
    expect(chunkSize(0)).toBe(1);
  });
});
