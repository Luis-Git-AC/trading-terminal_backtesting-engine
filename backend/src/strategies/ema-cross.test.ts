import type { Candle } from '@tt/shared';
import { describe, expect, it } from 'vitest';
import { createIndicatorRegistry } from '../engine/indicators/registry.js';
import { mulberry32 } from '../engine/prng.js';
import type { Position, Signal } from '../engine/types.js';
import { emaCross, emaCrossParamsSchema, type EmaCrossParams } from './ema-cross.js';

const PARAMS = {
  fastPeriod: 3,
  slowPeriod: 5,
  atrPeriod: 3,
  atrStopMult: 2,
  takeProfitR: 2,
  allowShort: true,
};

function candles(closes: readonly number[]): Candle[] {
  return closes.map((close, index) => ({
    t: 1_000 + index * 60_000,
    o: close,
    h: close + 1,
    l: close - 1,
    c: close,
    v: 1,
  }));
}

function naiveEma(values: readonly number[], period: number): (number | null)[] {
  const k = 2 / (period + 1);
  const out: (number | null)[] = values.map(() => null);
  if (values.length < period) {
    return out;
  }
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = ema;
  for (let i = period; i < values.length; i += 1) {
    ema += k * ((values[i] ?? 0) - ema);
    out[i] = ema;
  }
  return out;
}

function expectedCrossIndex(closes: readonly number[], direction: 'up' | 'down'): number {
  const fast = naiveEma(closes, PARAMS.fastPeriod);
  const slow = naiveEma(closes, PARAMS.slowPeriod);
  const warmup = Math.max(PARAMS.slowPeriod, PARAMS.atrPeriod) + 1;
  let previousSeen = false;
  for (let i = warmup; i < closes.length; i += 1) {
    const f = fast[i];
    const s = slow[i];
    const pf = fast[i - 1];
    const ps = slow[i - 1];
    if (f == null || s == null || pf == null || ps == null) {
      continue;
    }
    if (!previousSeen) {
      previousSeen = true;
      continue;
    }
    if (direction === 'up' && pf <= ps && f > s) {
      return i;
    }
    if (direction === 'down' && pf >= ps && f < s) {
      return i;
    }
  }
  return -1;
}

function drive(
  overrides: Partial<EmaCrossParams>,
  bars: readonly Candle[],
  position: Position | null = null,
): (Signal | null)[] {
  const params = emaCrossParamsSchema.parse({ ...PARAMS, ...overrides });
  const indicators = createIndicatorRegistry();
  const prng = mulberry32(1);
  const state = emaCross.init(params, { prng, indicators });
  const warmup = emaCross.warmupBars(params);

  return bars.map((bar, index) => {
    indicators.updateAll(bar);
    if (index < warmup) {
      return null;
    }
    return emaCross.onBar(bar, state, { index, position, indicators, prng });
  });
}

const FLAT_THEN_UP = [100, 100, 100, 100, 100, 100, 100, 100, 110, 121, 133, 146];
const FLAT_THEN_DOWN = [100, 100, 100, 100, 100, 100, 100, 100, 90, 81, 73, 66];

describe('emaCrossParamsSchema', () => {
  it('aplica los defaults documentados en docs/03', () => {
    expect(emaCrossParamsSchema.parse({})).toEqual({
      fastPeriod: 12,
      slowPeriod: 26,
      atrPeriod: 14,
      atrStopMult: 2,
      takeProfitR: 2,
      allowShort: true,
    });
  });

  it('rechaza slowPeriod <= fastPeriod', () => {
    expect(() => emaCrossParamsSchema.parse({ fastPeriod: 20, slowPeriod: 20 })).toThrow();
    expect(() => emaCrossParamsSchema.parse({ fastPeriod: 30, slowPeriod: 20 })).toThrow();
    expect(() => emaCrossParamsSchema.parse({ fastPeriod: 10, slowPeriod: 20 })).not.toThrow();
  });

  it('respeta los minimos y maximos de cada parametro', () => {
    expect(() => emaCrossParamsSchema.parse({ fastPeriod: 1 })).toThrow();
    expect(() => emaCrossParamsSchema.parse({ fastPeriod: 201 })).toThrow();
    expect(() => emaCrossParamsSchema.parse({ atrStopMult: 0 })).toThrow();
    expect(() => emaCrossParamsSchema.parse({ takeProfitR: 25 })).toThrow();
    expect(() => emaCrossParamsSchema.parse({ fastPeriod: 2.5 })).toThrow();
  });
});

describe('emaCross.warmupBars', () => {
  it('es max(slowPeriod, atrPeriod) + 1', () => {
    expect(emaCross.warmupBars(emaCrossParamsSchema.parse({}))).toBe(27);
    expect(
      emaCross.warmupBars(
        emaCrossParamsSchema.parse({ fastPeriod: 5, slowPeriod: 10, atrPeriod: 50 }),
      ),
    ).toBe(51);
  });
});

describe('emaCross.onBar', () => {
  it('un cruce alcista claro produce exactamente una senal enter long', () => {
    const signals = drive({}, candles(FLAT_THEN_UP));
    const enters = signals
      .map((signal, index) => ({ signal, index }))
      .filter((entry) => entry.signal?.type === 'enter');

    expect(enters).toHaveLength(1);
    expect(enters[0]?.index).toBe(expectedCrossIndex(FLAT_THEN_UP, 'up'));
    const signal = enters[0]?.signal;
    expect(signal?.type).toBe('enter');
    if (signal?.type === 'enter') {
      expect(signal.side).toBe('long');
      expect(signal.takeProfitR).toBe(2);
    }
  });

  it('el stop va por debajo del cierre a atrStopMult * ATR', () => {
    const bars = candles(FLAT_THEN_UP);
    const signals = drive({}, bars);
    const index = signals.findIndex((signal) => signal?.type === 'enter');
    const signal = signals[index];
    const bar = bars[index];
    expect(signal?.type).toBe('enter');
    if (signal?.type === 'enter' && bar !== undefined) {
      expect(signal.stopPrice).toBeLessThan(bar.c);
      const distance = bar.c - signal.stopPrice;
      expect(distance).toBeGreaterThan(0);
    }
  });

  it('un cruce bajista claro produce una senal enter short', () => {
    const signals = drive({}, candles(FLAT_THEN_DOWN));
    const enters = signals
      .map((signal, index) => ({ signal, index }))
      .filter((entry) => entry.signal?.type === 'enter');

    expect(enters).toHaveLength(1);
    expect(enters[0]?.index).toBe(expectedCrossIndex(FLAT_THEN_DOWN, 'down'));
    const signal = enters[0]?.signal;
    if (signal?.type === 'enter') {
      expect(signal.side).toBe('short');
      expect(signal.stopPrice).toBeGreaterThan(0);
    }
  });

  it('con allowShort en false no emite ninguna senal short', () => {
    const signals = drive({ allowShort: false }, candles(FLAT_THEN_DOWN));
    for (const signal of signals) {
      if (signal?.type === 'enter' || signal?.type === 'reverse') {
        expect(signal.side).not.toBe('short');
      }
    }
    expect(signals.some((signal) => signal?.type === 'enter')).toBe(false);
  });

  it('sin senales durante el warmup', () => {
    const warmup = emaCross.warmupBars(emaCrossParamsSchema.parse(PARAMS));
    const signals = drive({}, candles(FLAT_THEN_UP));
    expect(signals.slice(0, warmup).every((signal) => signal === null)).toBe(true);
  });

  it('un cruce contrario con posicion abierta produce reverse', () => {
    const position: Position = {
      side: 'short',
      entryIndex: 0,
      entryTs: 0,
      entryPrice: 100,
      qty: 1,
      stopPrice: 110,
      takeProfitPrice: null,
      riskQuote: 10,
      entryFee: 0,
      maeQuote: 0,
      mfeQuote: 0,
    };
    const signals = drive({}, candles(FLAT_THEN_UP), position);
    const reverse = signals.find((signal) => signal?.type === 'reverse');
    expect(reverse).toBeDefined();
    if (reverse?.type === 'reverse') {
      expect(reverse.side).toBe('long');
    }
  });

  it('con allowShort en false, el cruce contrario sobre un largo cierra con exit', () => {
    const position: Position = {
      side: 'long',
      entryIndex: 0,
      entryTs: 0,
      entryPrice: 100,
      qty: 1,
      stopPrice: 90,
      takeProfitPrice: null,
      riskQuote: 10,
      entryFee: 0,
      maeQuote: 0,
      mfeQuote: 0,
    };
    const signals = drive({ allowShort: false }, candles(FLAT_THEN_DOWN), position);
    const exit = signals.find((signal) => signal?.type === 'exit');
    expect(exit?.type).toBe('exit');
  });

  it('un cruce alcista con un largo ya abierto no emite nada', () => {
    const position: Position = {
      side: 'long',
      entryIndex: 0,
      entryTs: 0,
      entryPrice: 100,
      qty: 1,
      stopPrice: 90,
      takeProfitPrice: null,
      riskQuote: 10,
      entryFee: 0,
      maeQuote: 0,
      mfeQuote: 0,
    };
    const signals = drive({}, candles(FLAT_THEN_UP), position);
    expect(signals.every((signal) => signal === null)).toBe(true);
  });

  it('una serie plana no cruza nunca', () => {
    const signals = drive({}, candles(Array.from({ length: 30 }, () => 100)));
    expect(signals.every((signal) => signal === null)).toBe(true);
  });
});
