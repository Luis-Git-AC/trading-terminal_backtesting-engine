import type { Candle } from '@tt/shared';
import { describe, expect, it } from 'vitest';
import { createIndicatorRegistry } from '../engine/indicators/registry.js';
import { mulberry32 } from '../engine/prng.js';
import type { Position, Signal } from '../engine/types.js';
import {
  rangeBreakout,
  rangeBreakoutParamsSchema,
  resolveStopPrice,
  type RangeBreakoutParams,
} from './range-breakout.js';

const PARAMS = {
  lookback: 5,
  atrPeriod: 3,
  atrStopMult: 2,
  takeProfitR: 2,
  minAtrPct: 0,
  allowShort: true,
  stopMode: 'nearest' as const,
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

function drive(
  overrides: Partial<RangeBreakoutParams>,
  bars: readonly Candle[],
  position: Position | null = null,
): (Signal | null)[] {
  const params = rangeBreakoutParamsSchema.parse({ ...PARAMS, ...overrides });
  const indicators = createIndicatorRegistry();
  const prng = mulberry32(1);
  const state = rangeBreakout.init(params, { prng, indicators });
  const warmup = rangeBreakout.warmupBars(params);

  return bars.map((bar, index) => {
    indicators.updateAll(bar);
    if (index < warmup) {
      return null;
    }
    return rangeBreakout.onBar(bar, state, { index, position, indicators, prng });
  });
}

const FLAT = [100, 101, 99, 100, 101, 99, 100, 101];
const BREAKOUT_UP = [...FLAT, 120, 121];
const BREAKOUT_DOWN = [...FLAT, 80, 79];

describe('rangeBreakoutParamsSchema', () => {
  it('aplica defaults razonables', () => {
    expect(rangeBreakoutParamsSchema.parse({})).toEqual({
      lookback: 20,
      atrPeriod: 14,
      atrStopMult: 2,
      takeProfitR: 2,
      minAtrPct: 0,
      allowShort: true,
      stopMode: 'nearest',
    });
  });

  it('solo admite los tres stopMode documentados', () => {
    expect(() => rangeBreakoutParamsSchema.parse({ stopMode: 'trailing' })).toThrow();
    for (const stopMode of ['range', 'atr', 'nearest']) {
      expect(() => rangeBreakoutParamsSchema.parse({ stopMode })).not.toThrow();
    }
  });

  it('respeta minimos y maximos', () => {
    expect(() => rangeBreakoutParamsSchema.parse({ lookback: 1 })).toThrow();
    expect(() => rangeBreakoutParamsSchema.parse({ minAtrPct: -1 })).toThrow();
  });
});

describe('rangeBreakout.warmupBars', () => {
  it('es max(lookback, atrPeriod) + 1', () => {
    expect(rangeBreakout.warmupBars(rangeBreakoutParamsSchema.parse({}))).toBe(21);
    expect(
      rangeBreakout.warmupBars(rangeBreakoutParamsSchema.parse({ lookback: 5, atrPeriod: 30 })),
    ).toBe(31);
  });
});

describe('resolveStopPrice', () => {
  const params = rangeBreakoutParamsSchema.parse(PARAMS);

  it('stopMode range usa el lado opuesto del rango', () => {
    expect(resolveStopPrice('long', 120, 99, 5, { ...params, stopMode: 'range' })).toBe(99);
    expect(resolveStopPrice('short', 80, 101, 5, { ...params, stopMode: 'range' })).toBe(101);
  });

  it('stopMode atr usa la distancia por ATR', () => {
    expect(resolveStopPrice('long', 120, 99, 5, { ...params, stopMode: 'atr' })).toBe(110);
    expect(resolveStopPrice('short', 80, 101, 5, { ...params, stopMode: 'atr' })).toBe(90);
  });

  it('stopMode nearest se queda con el mas cercano al precio', () => {
    expect(resolveStopPrice('long', 120, 99, 5, params)).toBe(110);
    expect(resolveStopPrice('long', 120, 115, 5, params)).toBe(115);
    expect(resolveStopPrice('short', 80, 101, 5, params)).toBe(90);
    expect(resolveStopPrice('short', 80, 85, 5, params)).toBe(85);
  });
});

describe('rangeBreakout.onBar', () => {
  it('una ruptura al alza produce una senal enter long en la barra de la ruptura', () => {
    const bars = candles(BREAKOUT_UP);
    const signals = drive({}, bars);
    const index = signals.findIndex((signal) => signal?.type === 'enter');
    expect(index).toBe(FLAT.length);
    const signal = signals[index];
    if (signal?.type === 'enter') {
      expect(signal.side).toBe('long');
      expect(signal.stopPrice).toBeLessThan(bars[index]?.c ?? 0);
    }
  });

  it('una ruptura a la baja produce una senal enter short', () => {
    const signals = drive({}, candles(BREAKOUT_DOWN));
    const index = signals.findIndex((signal) => signal?.type === 'enter');
    expect(index).toBe(FLAT.length);
    const signal = signals[index];
    if (signal?.type === 'enter') {
      expect(signal.side).toBe('short');
    }
  });

  it('la ventana excluye la barra actual: romper el maximo previo basta', () => {
    const closes = [100, 100, 100, 100, 100, 100, 100, 100, 101];
    const signals = drive({}, candles(closes));
    const enters = signals.filter((signal) => signal?.type === 'enter');
    expect(enters).toHaveLength(1);
  });

  it('si la ventana incluyera la barra actual, un maximo nuevo nunca superaria su propio maximo', () => {
    const bars = candles([100, 100, 100, 100, 100, 100, 100, 100, 101]);
    const params = rangeBreakoutParamsSchema.parse(PARAMS);
    const indicators = createIndicatorRegistry();
    const prng = mulberry32(1);
    rangeBreakout.init(params, { prng, indicators });
    for (const bar of bars) {
      indicators.updateAll(bar);
    }
    const last = bars[bars.length - 1];
    expect(indicators.get('rangeHigh')).toBe(last?.c);
  });

  it('con minAtrPct alto no hay ninguna senal', () => {
    const signals = drive({ minAtrPct: 90 }, candles(BREAKOUT_UP));
    expect(signals.every((signal) => signal === null)).toBe(true);
  });

  it('con allowShort en false no emite cortos', () => {
    const signals = drive({ allowShort: false }, candles(BREAKOUT_DOWN));
    expect(signals.every((signal) => signal === null)).toBe(true);
  });

  it('sin senales durante el warmup', () => {
    const warmup = rangeBreakout.warmupBars(rangeBreakoutParamsSchema.parse(PARAMS));
    const signals = drive({}, candles(BREAKOUT_UP));
    expect(signals.slice(0, warmup).every((signal) => signal === null)).toBe(true);
  });

  it('una serie sin rupturas no emite nada', () => {
    const signals = drive({}, candles([...FLAT, ...FLAT]));
    expect(signals.every((signal) => signal === null)).toBe(true);
  });

  it('una ruptura contraria con posicion abierta produce reverse', () => {
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
    const signals = drive({}, candles(BREAKOUT_UP), position);
    const reverse = signals.find((signal) => signal?.type === 'reverse');
    expect(reverse?.type).toBe('reverse');
    if (reverse?.type === 'reverse') {
      expect(reverse.side).toBe('long');
    }
  });

  it('con stopMode range, un stop que caeria del lado equivocado descarta la senal', () => {
    const signals = drive({ stopMode: 'range' }, candles([100, 100, 100, 100, 100, 100, 100, 100, 101]));
    const enters = signals.filter((signal) => signal?.type === 'enter');
    expect(enters).toHaveLength(1);
    const signal = enters[0];
    if (signal?.type === 'enter') {
      expect(signal.stopPrice).toBe(100);
    }
  });
});
