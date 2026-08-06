import { describe, expect, it } from 'vitest';
import {
  CANDLE_SOURCES,
  candleRowToCandle,
  candleSchema,
  candleSourceSchema,
  type CandleRow,
} from './candle.js';

const VALID = {
  t: Date.parse('2026-03-01T00:00:00.000Z'),
  o: 60000,
  h: 60500,
  l: 59800,
  c: 60200,
  v: 12.5,
};

function reasons(input: unknown): string {
  const result = candleSchema.safeParse(input);
  return result.success ? '' : result.error.issues.map((issue) => issue.message).join('|');
}

describe('candleSourceSchema', () => {
  it('solo admite rest y ws', () => {
    expect(CANDLE_SOURCES).toEqual(['rest', 'ws']);
    expect(candleSourceSchema.safeParse('rest').success).toBe(true);
    expect(candleSourceSchema.safeParse('ws').success).toBe(true);
    expect(candleSourceSchema.safeParse('backfill').success).toBe(false);
  });
});

describe('candleSchema', () => {
  it('acepta una vela coherente', () => {
    expect(candleSchema.safeParse(VALID).success).toBe(true);
  });

  it('acepta una vela plana donde todo coincide', () => {
    expect(candleSchema.safeParse({ t: 0, o: 5, h: 5, l: 5, c: 5, v: 0 }).success).toBe(true);
  });

  it('rechaza high por debajo de low', () => {
    expect(reasons({ ...VALID, h: 59000 })).toContain('high debe ser >= low');
  });

  it('rechaza high por debajo de open o de close', () => {
    expect(reasons({ ...VALID, o: 61000 })).toContain('high debe ser >= open y >= close');
    expect(reasons({ ...VALID, c: 61000 })).toContain('high debe ser >= open y >= close');
  });

  it('rechaza low por encima de open o de close', () => {
    expect(reasons({ ...VALID, o: 59000, l: 59500 })).toContain('low debe ser <= open y <= close');
    expect(reasons({ ...VALID, c: 59000, l: 59500 })).toContain('low debe ser <= open y <= close');
  });

  it('rechaza timestamps no enteros o negativos', () => {
    expect(candleSchema.safeParse({ ...VALID, t: 1.5 }).success).toBe(false);
    expect(candleSchema.safeParse({ ...VALID, t: -1 }).success).toBe(false);
  });

  it('rechaza precios negativos y volumen negativo', () => {
    expect(candleSchema.safeParse({ ...VALID, l: -1 }).success).toBe(false);
    expect(candleSchema.safeParse({ ...VALID, v: -0.1 }).success).toBe(false);
  });

  it('rechaza valores no finitos', () => {
    expect(candleSchema.safeParse({ ...VALID, c: Number.NaN }).success).toBe(false);
    expect(candleSchema.safeParse({ ...VALID, h: Number.POSITIVE_INFINITY }).success).toBe(false);
  });

  it('rechaza campos ausentes', () => {
    expect(candleSchema.safeParse({ t: 0, o: 1, h: 1, l: 1 }).success).toBe(false);
  });
});

describe('candleRowToCandle', () => {
  it('convierte la fila de BD, con numeric como string, al tipo del dominio', () => {
    const row: CandleRow = {
      exchange: 'bitget',
      symbol: 'BTCUSDT',
      timeframe: '15m',
      ts: new Date('2026-03-01T00:00:00.000Z'),
      open: '60000.0000000000',
      high: '60500.0000000000',
      low: '59800.0000000000',
      close: '60200.0000000000',
      volume: '12.5000000000',
      quote_volume: '751250.0000000000',
      source: 'rest',
      ingested_at: new Date('2026-03-01T00:15:02.000Z'),
    };

    const candle = candleRowToCandle(row);

    expect(candle).toEqual(VALID);
    expect(candleSchema.safeParse(candle).success).toBe(true);
  });

  it('tolera quote_volume nulo', () => {
    const row: CandleRow = {
      exchange: 'bitget',
      symbol: 'BTCUSDT',
      timeframe: '1h',
      ts: new Date('2026-03-01T00:00:00.000Z'),
      open: '1',
      high: '2',
      low: '0.5',
      close: '1.5',
      volume: '0',
      quote_volume: null,
      source: 'ws',
      ingested_at: new Date('2026-03-01T01:00:00.000Z'),
    };

    expect(candleRowToCandle(row)).toEqual({
      t: Date.parse('2026-03-01T00:00:00.000Z'),
      o: 1,
      h: 2,
      l: 0.5,
      c: 1.5,
      v: 0,
    });
  });
});
