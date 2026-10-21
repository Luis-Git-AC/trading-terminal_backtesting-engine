import type { Candle } from '@tt/shared';
import { describe, expect, it } from 'vitest';
import { createIndicatorRegistry } from '../engine/indicators/registry.js';
import { mulberry32 } from '../engine/prng.js';
import type { Position, Signal } from '../engine/types.js';
import { smaPullback, smaPullbackParamsSchema, type SmaPullbackParams } from './sma-pullback.js';

const PARAMS = {
  trendPeriod: 5,
  pullbackPeriod: 3,
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

function drive(
  overrides: Partial<SmaPullbackParams>,
  bars: readonly Candle[],
  position: Position | null = null,
): (Signal | null)[] {
  const params = smaPullbackParamsSchema.parse({ ...PARAMS, ...overrides });
  const indicators = createIndicatorRegistry();
  const prng = mulberry32(1);
  const state = smaPullback.init(params, { prng, indicators });
  const warmup = smaPullback.warmupBars(params);

  return bars.map((bar, index) => {
    indicators.updateAll(bar);
    if (index < warmup) {
      return null;
    }
    return smaPullback.onBar(bar, state, { index, position, indicators, prng });
  });
}

const OPEN_POSITION = {
  entryIndex: 0,
  entryTs: 0,
  entryPrice: 100,
  qty: 1,
  takeProfitPrice: null,
  riskQuote: 10,
  entryFee: 0,
  maeQuote: 0,
  mfeQuote: 0,
};

// Tendencia alcista; el 109 del indice 7 cae bajo la SMA rapida y el 115 del 8 la recupera.
const UPTREND_PULLBACK = [100, 102, 104, 106, 108, 110, 112, 109, 115, 117];
// Espejo bajista: el 111 del indice 7 rebota sobre la SMA rapida y el 105 del 8 la pierde.
const DOWNTREND_PULLBACK = [120, 118, 116, 114, 112, 110, 108, 111, 105, 103];
const FLAT = Array.from({ length: 30 }, () => 100);

describe('smaPullbackParamsSchema', () => {
  it('aplica los defaults documentados', () => {
    expect(smaPullbackParamsSchema.parse({})).toEqual({
      trendPeriod: 50,
      pullbackPeriod: 10,
      atrPeriod: 14,
      atrStopMult: 2,
      takeProfitR: 2,
      allowShort: true,
    });
  });

  it('rechaza trendPeriod <= pullbackPeriod', () => {
    expect(() => smaPullbackParamsSchema.parse({ trendPeriod: 10, pullbackPeriod: 10 })).toThrow();
    expect(() => smaPullbackParamsSchema.parse({ trendPeriod: 5, pullbackPeriod: 20 })).toThrow();
    expect(() =>
      smaPullbackParamsSchema.parse({ trendPeriod: 30, pullbackPeriod: 10 }),
    ).not.toThrow();
  });

  it('respeta los minimos y maximos de cada parametro', () => {
    expect(() => smaPullbackParamsSchema.parse({ trendPeriod: 1 })).toThrow();
    expect(() => smaPullbackParamsSchema.parse({ trendPeriod: 401 })).toThrow();
    expect(() => smaPullbackParamsSchema.parse({ pullbackPeriod: 2.5 })).toThrow();
    expect(() => smaPullbackParamsSchema.parse({ atrStopMult: 0 })).toThrow();
  });
});

describe('smaPullback.warmupBars', () => {
  it('es max(trendPeriod, pullbackPeriod, atrPeriod) + 1', () => {
    expect(smaPullback.warmupBars(smaPullbackParamsSchema.parse({}))).toBe(51);
    expect(
      smaPullback.warmupBars(
        smaPullbackParamsSchema.parse({ trendPeriod: 20, pullbackPeriod: 10, atrPeriod: 80 }),
      ),
    ).toBe(81);
  });
});

describe('smaPullback.onBar', () => {
  it('recuperar la SMA rapida en tendencia alcista produce enter long', () => {
    const signals = drive({}, candles(UPTREND_PULLBACK));
    const enters = signals
      .map((signal, index) => ({ signal, index }))
      .filter((entry) => entry.signal?.type === 'enter');

    expect(enters).toHaveLength(1);
    expect(enters[0]?.index).toBe(8);
    const signal = enters[0]?.signal;
    if (signal?.type === 'enter') {
      expect(signal.side).toBe('long');
      expect(signal.takeProfitR).toBe(2);
    }
  });

  it('no entra en la barra del retroceso, solo cuando lo recupera', () => {
    const signals = drive({}, candles(UPTREND_PULLBACK));
    expect(signals[7]).toBeNull();
  });

  it('el stop de un largo queda por debajo del cierre', () => {
    const bars = candles(UPTREND_PULLBACK);
    const signals = drive({}, bars);
    const index = signals.findIndex((signal) => signal?.type === 'enter');
    const signal = signals[index];
    const bar = bars[index];
    if (signal?.type === 'enter' && bar !== undefined) {
      expect(signal.stopPrice).toBeLessThan(bar.c);
    }
  });

  it('perder la SMA rapida en tendencia bajista produce enter short', () => {
    const signals = drive({}, candles(DOWNTREND_PULLBACK));
    const enters = signals
      .map((signal, index) => ({ signal, index }))
      .filter((entry) => entry.signal?.type === 'enter');

    expect(enters).toHaveLength(1);
    expect(enters[0]?.index).toBe(8);
    const signal = enters[0]?.signal;
    if (signal?.type === 'enter') {
      expect(signal.side).toBe('short');
    }
  });

  it('con allowShort en false no emite ninguna senal short', () => {
    const signals = drive({ allowShort: false }, candles(DOWNTREND_PULLBACK));
    for (const signal of signals) {
      if (signal?.type === 'enter' || signal?.type === 'reverse') {
        expect(signal.side).not.toBe('short');
      }
    }
  });

  it('una serie plana no cruza ninguna media y no emite nada', () => {
    const signals = drive({}, candles(FLAT));
    expect(signals.every((signal) => signal === null)).toBe(true);
  });

  it('una senal contraria con posicion abierta produce reverse', () => {
    const position: Position = { ...OPEN_POSITION, side: 'short', stopPrice: 130 };
    const signals = drive({}, candles(UPTREND_PULLBACK), position);
    const reverse = signals.find((signal) => signal?.type === 'reverse');
    expect(reverse).toBeDefined();
    if (reverse?.type === 'reverse') {
      expect(reverse.side).toBe('long');
    }
  });

  it('sin senales durante el warmup', () => {
    const warmup = smaPullback.warmupBars(smaPullbackParamsSchema.parse(PARAMS));
    const signals = drive({}, candles(UPTREND_PULLBACK));
    expect(signals.slice(0, warmup).every((signal) => signal === null)).toBe(true);
  });
});
