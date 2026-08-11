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
import { scanGaps } from './gap-scanner.js';

const SYMBOL = 'SCANUSDT';
const TIMEFRAME: Timeframe = '1m';
const STEP = timeframeToMs(TIMEFRAME);
const START = Date.UTC(2026, 6, 1, 0, 0, 0);
const TOTAL = 60;
const TO = START + TOTAL * STEP;

function makeCandle(index: number): Candle {
  const base = 64_000 + index;
  return { t: START + index * STEP, o: base, h: base + 10, l: base - 10, c: base + 5, v: 1 + index };
}

describe('scanGaps', () => {
  let db: ScratchDatabase;
  let candles: CandlesRepository;
  let gaps: GapsRepository;

  beforeAll(async () => {
    db = await createScratchDatabase({ applicationName: 'tt-itest-gap-scan' });
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

  function scan(overrides: Partial<Parameters<typeof scanGaps>[0]> = {}) {
    return scanGaps({
      pool: db.pool,
      series: [{ symbol: SYMBOL, timeframe: TIMEFRAME }],
      to: TO,
      windowMs: TOTAL * STEP,
      ...overrides,
    });
  }

  it('sin huecos no registra nada', async () => {
    const report = await scan();

    expect(report.found).toBe(0);
    expect(report.recorded).toBe(0);
    expect(await gaps.listOpen({ symbol: SYMBOL, timeframe: TIMEFRAME })).toEqual([]);
  });

  it('borrar 3 velas seguidas se detecta como un hueco con el rango exacto', async () => {
    await deleteIndices([20, 21, 22]);

    const report = await scan();

    expect(report.found).toBe(1);
    expect(report.recorded).toBe(1);
    expect(report.series[0]?.missing).toBe(3);

    const open = await gaps.listOpen({ symbol: SYMBOL, timeframe: TIMEFRAME });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      symbol: SYMBOL,
      timeframe: TIMEFRAME,
      fromTs: START + 20 * STEP,
      toTs: START + 22 * STEP,
      filledAt: null,
      attempts: 0,
      lastError: null,
    });
  });

  it('varios huecos separados se registran uno por uno', async () => {
    await deleteIndices([5, 10, 11, 40]);

    const report = await scan();

    expect(report.found).toBe(3);
    const open = await gaps.listOpen({ symbol: SYMBOL, timeframe: TIMEFRAME });
    expect(open.map((gap) => [gap.fromTs, gap.toTs])).toEqual([
      [START + 5 * STEP, START + 5 * STEP],
      [START + 10 * STEP, START + 11 * STEP],
      [START + 40 * STEP, START + 40 * STEP],
    ]);
  });

  it('ejecutar el scanner dos veces no duplica filas en ingest_gaps', async () => {
    await deleteIndices([20, 21, 22]);

    await scan();
    await scan();
    await scan();

    const { rows } = await db.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM ingest_gaps WHERE symbol = $1',
      [SYMBOL],
    );
    expect(rows[0]?.count).toBe('1');
  });

  it('un hueco que crece ensancha la fila abierta en vez de crear otra', async () => {
    await deleteIndices([20, 21]);
    await scan();

    await deleteIndices([22, 23]);
    await scan();

    const open = await gaps.listOpen({ symbol: SYMBOL, timeframe: TIMEFRAME });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      fromTs: START + 20 * STEP,
      toTs: START + 23 * STEP,
    });
  });

  it('un hueco ya cerrado como no-data-upstream no se vuelve a abrir', async () => {
    await deleteIndices([20, 21, 22]);
    await scan();

    const open = await gaps.listOpen({ symbol: SYMBOL, timeframe: TIMEFRAME });
    const first = open[0];
    if (first === undefined) throw new Error('se esperaba un hueco abierto');
    await gaps.markFilled({ id: first.id, lastError: NO_DATA_UPSTREAM });

    const report = await scan();

    expect(report.found).toBe(1);
    expect(report.recorded).toBe(0);
    expect(report.suppressed).toBe(1);
    expect(await gaps.listOpen({ symbol: SYMBOL, timeframe: TIMEFRAME })).toEqual([]);
  });

  it('la ventana acota la busqueda y deja fuera los huecos antiguos', async () => {
    await deleteIndices([2, 3]);

    const report = await scan({ windowMs: 20 * STEP });

    expect(report.series[0]?.fromTs).toBe(TO - 20 * STEP);
    expect(report.found).toBe(0);
  });

  it('recorre todas las series que se le pasan', async () => {
    await candles.upsertCandles({
      symbol: 'SCAN2USDT',
      timeframe: TIMEFRAME,
      source: 'ws',
      candles: Array.from({ length: TOTAL }, (_, index) => makeCandle(index)),
    });
    await db.pool.query('DELETE FROM candles WHERE symbol = $1 AND ts = $2', [
      'SCAN2USDT',
      new Date(START + 30 * STEP),
    ]);
    await deleteIndices([20]);

    const report = await scan({
      series: [
        { symbol: SYMBOL, timeframe: TIMEFRAME },
        { symbol: 'SCAN2USDT', timeframe: TIMEFRAME },
      ],
    });

    expect(report.series.map((item) => [item.symbol, item.found])).toEqual([
      [SYMBOL, 1],
      ['SCAN2USDT', 1],
    ]);
    expect(await gaps.listOpen({ symbol: 'SCAN2USDT', timeframe: TIMEFRAME })).toHaveLength(1);
  });
});
