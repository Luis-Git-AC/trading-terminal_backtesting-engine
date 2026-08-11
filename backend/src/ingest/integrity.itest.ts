import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { timeframeToMs, type Candle, type Timeframe } from '@tt/shared';
import { runMigrations } from '../db/migrate.js';
import { createCandlesRepository, type CandlesRepository } from '../db/repositories/candles.repo.js';
import { createScratchDatabase, type ScratchDatabase } from '../testing/scratch-db.js';
import { verifyIntegrity, type ViolationKind } from './integrity.js';

const SYMBOL = 'BTCUSDT';
const TIMEFRAME: Timeframe = '15m';
const STEP = timeframeToMs(TIMEFRAME);
const START = Date.UTC(2026, 0, 1, 0, 0, 0);
const COUNT = 20;
const END = START + COUNT * STEP;
const NOW = END + STEP;

const RAW_INSERT = `
  INSERT INTO candles (exchange, symbol, timeframe, ts, open, high, low, close, volume, source)
  VALUES ('bitget', $1, $2, $3, $4, $5, $6, $7, $8, 'rest')
`;

function makeCandles(count = COUNT): Candle[] {
  return Array.from({ length: count }, (_, index) => {
    const base = 60_000 + index;
    return { t: START + index * STEP, o: base, h: base + 10, l: base - 10, c: base + 5, v: 1 };
  });
}

const series = { symbol: SYMBOL, timeframe: TIMEFRAME };

describe('verifyIntegrity sobre una serie sana', () => {
  let db: ScratchDatabase;
  let candles: CandlesRepository;

  beforeAll(async () => {
    db = await createScratchDatabase({ applicationName: 'tt-itest-integrity' });
    await runMigrations({ pool: db.pool });
    candles = createCandlesRepository(db.pool);
  });

  afterAll(async () => {
    await db.drop();
  });

  beforeEach(async () => {
    await db.pool.query('DELETE FROM candles');
    await candles.upsertCandles({ ...series, source: 'rest', candles: makeCandles() });
  });

  it('no encuentra ninguna violacion', async () => {
    const report = await verifyIntegrity({
      db: db.pool,
      ...series,
      from: START,
      to: END,
      now: () => NOW,
    });

    expect(report.ok).toBe(true);
    expect(report.totalViolations).toBe(0);
    expect(report.violations).toEqual([]);
    expect(report.gaps).toEqual([]);
  });

  it('cuadra expected con actual y reporta los extremos', async () => {
    const report = await verifyIntegrity({
      db: db.pool,
      ...series,
      from: START,
      to: END,
      now: () => NOW,
    });

    expect(report.expected).toBe(COUNT);
    expect(report.actual).toBe(COUNT);
    expect(report.missing).toBe(0);
    expect(report.firstTs).toBe(START);
    expect(report.lastTs).toBe(END - STEP);
  });

  it('recorre la serie entera aunque no quepa en una pagina', async () => {
    const report = await verifyIntegrity({
      db: db.pool,
      ...series,
      from: START,
      to: END,
      now: () => NOW,
      pageSize: 3,
    });

    expect(report.actual).toBe(COUNT);
    expect(report.ok).toBe(true);
  });

  it('lista los huecos con rangos exactos sin marcarlos como violacion', async () => {
    await db.pool.query('DELETE FROM candles WHERE ts >= $1 AND ts <= $2', [
      new Date(START + 5 * STEP),
      new Date(START + 7 * STEP),
    ]);
    await db.pool.query('DELETE FROM candles WHERE ts = $1', [new Date(START + 12 * STEP)]);

    const report = await verifyIntegrity({
      db: db.pool,
      ...series,
      from: START,
      to: END,
      now: () => NOW,
    });

    expect(report.gaps).toEqual([
      { fromTs: START + 5 * STEP, toTs: START + 7 * STEP, missing: 3 },
      { fromTs: START + 12 * STEP, toTs: START + 12 * STEP, missing: 1 },
    ]);
    expect(report.actual).toBe(COUNT - 4);
    expect(report.missing).toBe(4);
    expect(report.ok).toBe(true);
    expect(report.totalViolations).toBe(0);
  });
});

describe('verifyIntegrity detecta cada tipo de violacion', () => {
  let db: ScratchDatabase;

  beforeAll(async () => {
    db = await createScratchDatabase({ applicationName: 'tt-itest-integrity-loose' });
    await runMigrations({ pool: db.pool });
    await db.pool.query('ALTER TABLE candles DROP CONSTRAINT candles_ohlc_sane');
    await db.pool.query('ALTER TABLE candles DROP CONSTRAINT candles_pkey');
  });

  afterAll(async () => {
    await db.drop();
  });

  beforeEach(async () => {
    await db.pool.query('DELETE FROM candles');
  });

  async function insertRaw(
    ts: number,
    values: { o?: number; h?: number; l?: number; c?: number; v?: number } = {},
  ): Promise<void> {
    await db.pool.query(RAW_INSERT, [
      SYMBOL,
      TIMEFRAME,
      new Date(ts),
      String(values.o ?? 60_000),
      String(values.h ?? 60_010),
      String(values.l ?? 59_990),
      String(values.c ?? 60_005),
      String(values.v ?? 1),
    ]);
  }

  async function kindsFound(): Promise<ViolationKind[]> {
    const report = await verifyIntegrity({
      db: db.pool,
      ...series,
      from: START,
      to: END + 10 * STEP,
      now: () => NOW,
    });
    return [...new Set(report.violations.map((violation) => violation.kind))];
  }

  it('1. ts no alineado al timeframe', async () => {
    await insertRaw(START + 3 * STEP + 60_000);

    const report = await verifyIntegrity({
      db: db.pool,
      ...series,
      from: START,
      to: END,
      now: () => NOW,
    });

    expect(report.ok).toBe(false);
    expect(report.violationCounts.unaligned).toBe(1);
    expect(report.violations[0]).toMatchObject({
      kind: 'unaligned',
      ts: START + 3 * STEP + 60_000,
    });
    expect(report.violations[0]?.detail).toContain('15m');
  });

  it('2. duplicados con la misma clave', async () => {
    await insertRaw(START);
    await insertRaw(START);
    await insertRaw(START + STEP);

    const report = await verifyIntegrity({
      db: db.pool,
      ...series,
      from: START,
      to: END,
      now: () => NOW,
    });

    expect(report.ok).toBe(false);
    expect(report.violationCounts.duplicate).toBe(1);
    expect(report.violations[0]).toMatchObject({ kind: 'duplicate', ts: START });
    expect(report.violations[0]?.detail).toContain('2 filas');
  });

  it('3. coherencia OHLC: high por debajo de low', async () => {
    await insertRaw(START, { h: 100, l: 200 });

    const report = await verifyIntegrity({
      db: db.pool,
      ...series,
      from: START,
      to: END,
      now: () => NOW,
    });

    expect(report.violationCounts['invalid-ohlc']).toBe(1);
    expect(report.violations[0]?.detail).toContain('OHLC incoherente');
  });

  it('3b. coherencia OHLC: high por debajo de open o close', async () => {
    await insertRaw(START, { o: 60_000, h: 60_000, l: 59_000, c: 60_500 });
    await insertRaw(START + STEP, { o: 60_000, h: 61_000, l: 60_500, c: 60_800 });

    const report = await verifyIntegrity({
      db: db.pool,
      ...series,
      from: START,
      to: END,
      now: () => NOW,
    });

    expect(report.violationCounts['invalid-ohlc']).toBe(2);
  });

  it('4. volumen negativo', async () => {
    await insertRaw(START, { v: -5 });

    const report = await verifyIntegrity({
      db: db.pool,
      ...series,
      from: START,
      to: END,
      now: () => NOW,
    });

    expect(report.violationCounts['negative-volume']).toBe(1);
    expect(report.violations[0]?.detail).toContain('-5');
  });

  it('5. velas en el futuro', async () => {
    await insertRaw(START);
    await insertRaw(NOW + STEP);

    const report = await verifyIntegrity({
      db: db.pool,
      ...series,
      from: START,
      to: NOW + 10 * STEP,
      now: () => NOW,
    });

    expect(report.violationCounts.future).toBe(1);
    expect(report.violations[0]).toMatchObject({ kind: 'future', ts: NOW + STEP });
  });

  it('6. la vela del periodo todavia abierto se marca como en formacion', async () => {
    const forming = NOW - STEP + 1000;
    await insertRaw(START);
    await insertRaw(forming - (forming % STEP));

    const report = await verifyIntegrity({
      db: db.pool,
      ...series,
      from: START,
      to: NOW + 10 * STEP,
      now: () => NOW - STEP + 1000,
    });

    expect(report.violationCounts.unclosed).toBe(1);
    expect(report.violationCounts.future).toBe(0);
    expect(report.ok).toBe(false);
    expect(report.violations[0]).toMatchObject({
      kind: 'unclosed',
      ts: NOW - STEP,
    });
    expect(report.violations[0]?.detail).toContain('sigue en formacion');
  });

  it('6b. la vela que cierra exactamente ahora ya no esta en formacion', async () => {
    await insertRaw(START);
    await insertRaw(NOW - STEP);

    const report = await verifyIntegrity({
      db: db.pool,
      ...series,
      from: START,
      to: NOW + 10 * STEP,
      now: () => NOW,
    });

    expect(report.violationCounts.unclosed).toBe(0);
    expect(report.ok).toBe(true);
  });

  it('6c. una vela en el futuro cuenta solo como future, no tambien como en formacion', async () => {
    await insertRaw(START);
    await insertRaw(NOW + STEP);

    const report = await verifyIntegrity({
      db: db.pool,
      ...series,
      from: START,
      to: NOW + 10 * STEP,
      now: () => NOW,
    });

    expect(report.violationCounts.future).toBe(1);
    expect(report.violationCounts.unclosed).toBe(0);
    expect(report.totalViolations).toBe(1);
  });

  it('acumula varias violaciones distintas en un solo informe', async () => {
    await insertRaw(START, { h: 1, l: 2 });
    await insertRaw(START + STEP + 1000);
    await insertRaw(START + 2 * STEP, { v: -1 });
    await insertRaw(NOW + STEP);
    await insertRaw(START + 3 * STEP);
    await insertRaw(START + 3 * STEP);

    expect((await kindsFound()).sort()).toEqual([
      'duplicate',
      'future',
      'invalid-ohlc',
      'negative-volume',
      'unaligned',
    ]);
  });

  it('acota la lista de violaciones pero no el recuento', async () => {
    for (let index = 0; index < 8; index += 1) {
      await insertRaw(START + index * STEP, { v: -1 });
    }

    const report = await verifyIntegrity({
      db: db.pool,
      ...series,
      from: START,
      to: END,
      now: () => NOW,
      maxViolations: 3,
    });

    expect(report.violations).toHaveLength(3);
    expect(report.totalViolations).toBe(8);
    expect(report.violationCounts['negative-volume']).toBe(8);
    expect(report.ok).toBe(false);
  });

  it('una serie sana en la misma tabla sin constraints sigue saliendo OK', async () => {
    for (const candle of makeCandles()) {
      await insertRaw(candle.t, candle);
    }

    const report = await verifyIntegrity({
      db: db.pool,
      ...series,
      from: START,
      to: END,
      now: () => NOW,
    });

    expect(report.ok).toBe(true);
    expect(report.actual).toBe(COUNT);
  });
});
