import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { timeframeToMs, type Candle, type Timeframe } from '@tt/shared';
import { runMigrations } from '../migrate.js';
import { createScratchDatabase, type ScratchDatabase } from '../../testing/scratch-db.js';
import {
  MAX_CANDLES_LIMIT,
  createCandlesRepository,
  type CandlesRepository,
} from './candles.repo.js';

const SYMBOL = 'BTCUSDT';
const TIMEFRAME: Timeframe = '15m';
const STEP = timeframeToMs(TIMEFRAME);
const START = Date.UTC(2026, 0, 1, 0, 0, 0);

function makeCandles(count: number, from = START, step = STEP): Candle[] {
  return Array.from({ length: count }, (_, index) => {
    const base = 60_000 + index;
    return {
      t: from + index * step,
      o: base,
      h: base + 10,
      l: base - 10,
      c: base + 5,
      v: 1 + index / 100,
    };
  });
}

async function countRows(db: ScratchDatabase): Promise<number> {
  const { rows } = await db.pool.query<{ count: string }>('SELECT count(*)::text AS count FROM candles');
  return Number(rows[0]?.count ?? 0);
}

describe('candles.repo', () => {
  let db: ScratchDatabase;
  let repo: CandlesRepository;

  beforeAll(async () => {
    db = await createScratchDatabase({ applicationName: 'tt-itest-candles-repo' });
    await runMigrations({ pool: db.pool });
    repo = createCandlesRepository(db.pool);
  });

  afterAll(async () => {
    await db.drop();
  });

  beforeEach(async () => {
    await db.pool.query('DELETE FROM candles');
  });

  describe('upsertCandles', () => {
    it('inserta 5.000 velas en menos de 2 s y devuelve las filas afectadas', async () => {
      const candles = makeCandles(5000);

      const startedAt = Date.now();
      const affected = await repo.upsertCandles({
        symbol: SYMBOL,
        timeframe: TIMEFRAME,
        source: 'rest',
        candles,
      });
      const elapsed = Date.now() - startedAt;

      expect(affected).toBe(5000);
      expect(await countRows(db)).toBe(5000);
      expect(elapsed, `el upsert tardo ${elapsed} ms`).toBeLessThan(2000);
    });

    it('reinsertar el mismo lote no duplica y actualiza source y OHLCV', async () => {
      const candles = makeCandles(50);
      await repo.upsertCandles({
        symbol: SYMBOL,
        timeframe: TIMEFRAME,
        source: 'rest',
        candles,
      });

      const corrected = candles.map((candle) => ({ ...candle, c: candle.c + 1, v: candle.v * 2 }));
      const affected = await repo.upsertCandles({
        symbol: SYMBOL,
        timeframe: TIMEFRAME,
        source: 'ws',
        candles: corrected,
      });

      expect(affected).toBe(50);
      expect(await countRows(db)).toBe(50);

      const { rows } = await db.pool.query<{ source: string; close: string; volume: string }>(
        'SELECT source, close, volume FROM candles WHERE ts = $1',
        [new Date(START)],
      );
      expect(rows[0]?.source).toBe('ws');
      expect(Number(rows[0]?.close)).toBe(60_005 + 1);
      expect(Number(rows[0]?.volume)).toBe(2);
    });

    it('parte los lotes grandes en trozos y suma las filas de todos', async () => {
      const affected = await repo.upsertCandles({
        symbol: SYMBOL,
        timeframe: TIMEFRAME,
        source: 'rest',
        candles: makeCandles(2500),
      });

      expect(affected).toBe(2500);
      expect(await countRows(db)).toBe(2500);
    });

    it('un lote vacio no toca la base de datos', async () => {
      expect(
        await repo.upsertCandles({
          symbol: SYMBOL,
          timeframe: TIMEFRAME,
          source: 'rest',
          candles: [],
        }),
      ).toBe(0);
      expect(await countRows(db)).toBe(0);
    });

    it('no mezcla series distintas bajo la misma clave', async () => {
      const candles = makeCandles(10);
      await repo.upsertCandles({ symbol: SYMBOL, timeframe: '15m', source: 'rest', candles });
      await repo.upsertCandles({ symbol: SYMBOL, timeframe: '1h', source: 'rest', candles });
      await repo.upsertCandles({ symbol: 'ETHUSDT', timeframe: '15m', source: 'rest', candles });
      await repo.upsertCandles({
        exchange: 'otro',
        symbol: SYMBOL,
        timeframe: '15m',
        source: 'rest',
        candles,
      });

      expect(await countRows(db)).toBe(40);
      expect(await repo.getCoverage({ symbol: SYMBOL, timeframe: '15m' })).toMatchObject({
        rows: 10,
      });
    });
  });

  describe('getCandles', () => {
    beforeEach(async () => {
      await repo.upsertCandles({
        symbol: SYMBOL,
        timeframe: TIMEFRAME,
        source: 'rest',
        candles: makeCandles(10),
      });
    });

    it('respeta el intervalo semiabierto [from, to)', async () => {
      const candles = await repo.getCandles({
        symbol: SYMBOL,
        timeframe: TIMEFRAME,
        from: START + 2 * STEP,
        to: START + 5 * STEP,
      });

      expect(candles.map((candle) => candle.t)).toEqual([
        START + 2 * STEP,
        START + 3 * STEP,
        START + 4 * STEP,
      ]);
    });

    it('un rango de una sola vela devuelve exactamente esa vela', async () => {
      const candles = await repo.getCandles({
        symbol: SYMBOL,
        timeframe: TIMEFRAME,
        from: START,
        to: START + STEP,
      });

      expect(candles).toEqual([{ t: START, o: 60_000, h: 60_010, l: 59_990, c: 60_005, v: 1 }]);
    });

    it('un rango invertido o vacio devuelve cero velas', async () => {
      await expect(
        repo.getCandles({ symbol: SYMBOL, timeframe: TIMEFRAME, from: START + 5 * STEP, to: START }),
      ).resolves.toEqual([]);
    });

    it('devuelve las velas en orden ascendente', async () => {
      const candles = await repo.getCandles({
        symbol: SYMBOL,
        timeframe: TIMEFRAME,
        from: START,
        to: START + 10 * STEP,
      });

      const timestamps = candles.map((candle) => candle.t);
      expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
      expect(timestamps).toHaveLength(10);
    });

    it('acota el limit al maximo aunque se pida mas', async () => {
      await repo.upsertCandles({
        symbol: 'LIMITUSDT',
        timeframe: TIMEFRAME,
        source: 'rest',
        candles: makeCandles(MAX_CANDLES_LIMIT + 100),
      });

      const candles = await repo.getCandles({
        symbol: 'LIMITUSDT',
        timeframe: TIMEFRAME,
        from: START,
        to: START + (MAX_CANDLES_LIMIT + 100) * STEP,
        limit: 99_999,
      });

      expect(candles).toHaveLength(MAX_CANDLES_LIMIT);
    });

    it('respeta un limit menor que el maximo', async () => {
      const candles = await repo.getCandles({
        symbol: SYMBOL,
        timeframe: TIMEFRAME,
        from: START,
        to: START + 10 * STEP,
        limit: 3,
      });

      expect(candles).toHaveLength(3);
    });

    it('convierte los numeric de la BD a numeros del dominio sin perder el valor', async () => {
      const [first] = await repo.getCandles({
        symbol: SYMBOL,
        timeframe: TIMEFRAME,
        from: START,
        to: START + STEP,
      });

      expect(first).toEqual({ t: START, o: 60_000, h: 60_010, l: 59_990, c: 60_005, v: 1 });
    });
  });

  describe('getCoverage y getLastCandleTs', () => {
    it('sobre una serie vacia devuelve nulos y cero filas', async () => {
      expect(await repo.getCoverage({ symbol: SYMBOL, timeframe: TIMEFRAME })).toEqual({
        fromTs: null,
        toTs: null,
        rows: 0,
      });
      expect(await repo.getLastCandleTs({ symbol: SYMBOL, timeframe: TIMEFRAME })).toBeNull();
    });

    it('devuelve el primer ts, el ultimo y el numero de filas', async () => {
      await repo.upsertCandles({
        symbol: SYMBOL,
        timeframe: TIMEFRAME,
        source: 'rest',
        candles: makeCandles(10),
      });

      expect(await repo.getCoverage({ symbol: SYMBOL, timeframe: TIMEFRAME })).toEqual({
        fromTs: START,
        toTs: START + 9 * STEP,
        rows: 10,
      });
      expect(await repo.getLastCandleTs({ symbol: SYMBOL, timeframe: TIMEFRAME })).toBe(
        START + 9 * STEP,
      );
    });
  });

  describe('findGaps', () => {
    beforeEach(async () => {
      await repo.upsertCandles({
        symbol: SYMBOL,
        timeframe: TIMEFRAME,
        source: 'rest',
        candles: makeCandles(10),
      });
    });

    it('detecta un hueco fabricado de 3 velas con los limites exactos', async () => {
      await db.pool.query('DELETE FROM candles WHERE ts >= $1 AND ts <= $2', [
        new Date(START + 4 * STEP),
        new Date(START + 6 * STEP),
      ]);

      const gaps = await repo.findGaps({
        symbol: SYMBOL,
        timeframe: TIMEFRAME,
        from: START,
        to: START + 10 * STEP,
      });

      expect(gaps).toEqual([
        { fromTs: START + 4 * STEP, toTs: START + 6 * STEP, missing: 3 },
      ]);
    });

    it('detecta un hueco de una sola vela', async () => {
      await db.pool.query('DELETE FROM candles WHERE ts = $1', [new Date(START + 2 * STEP)]);

      const gaps = await repo.findGaps({
        symbol: SYMBOL,
        timeframe: TIMEFRAME,
        from: START,
        to: START + 10 * STEP,
      });

      expect(gaps).toEqual([
        { fromTs: START + 2 * STEP, toTs: START + 2 * STEP, missing: 1 },
      ]);
    });

    it('devuelve varios huecos ordenados por inicio', async () => {
      await db.pool.query('DELETE FROM candles WHERE ts = $1 OR ts = $2', [
        new Date(START + 2 * STEP),
        new Date(START + 7 * STEP),
      ]);

      const gaps = await repo.findGaps({
        symbol: SYMBOL,
        timeframe: TIMEFRAME,
        from: START,
        to: START + 10 * STEP,
      });

      expect(gaps.map((gap) => gap.fromTs)).toEqual([START + 2 * STEP, START + 7 * STEP]);
    });

    it('una serie continua no tiene huecos', async () => {
      await expect(
        repo.findGaps({ symbol: SYMBOL, timeframe: TIMEFRAME, from: START, to: START + 10 * STEP }),
      ).resolves.toEqual([]);
    });

    it('solo mira dentro de la ventana pedida', async () => {
      await db.pool.query('DELETE FROM candles WHERE ts = $1', [new Date(START + 7 * STEP)]);

      await expect(
        repo.findGaps({ symbol: SYMBOL, timeframe: TIMEFRAME, from: START, to: START + 5 * STEP }),
      ).resolves.toEqual([]);
    });

    it('no confunde el hueco de una serie con el de otra', async () => {
      await repo.upsertCandles({
        symbol: 'ETHUSDT',
        timeframe: TIMEFRAME,
        source: 'rest',
        candles: makeCandles(10),
      });
      await db.pool.query('DELETE FROM candles WHERE symbol = $1 AND ts = $2', [
        'ETHUSDT',
        new Date(START + 3 * STEP),
      ]);

      await expect(
        repo.findGaps({ symbol: SYMBOL, timeframe: TIMEFRAME, from: START, to: START + 10 * STEP }),
      ).resolves.toEqual([]);
      await expect(
        repo.findGaps({
          symbol: 'ETHUSDT',
          timeframe: TIMEFRAME,
          from: START,
          to: START + 10 * STEP,
        }),
      ).resolves.toHaveLength(1);
    });
  });
});
