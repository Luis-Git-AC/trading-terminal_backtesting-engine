import type { Candle } from '@tt/shared';
import { describe, expect, it } from 'vitest';
import { createIndicatorRegistry } from '../engine/indicators/registry.js';
import { mulberry32 } from '../engine/prng.js';
import type { Position, Signal } from '../engine/types.js';
import {
  rsiReversion,
  rsiReversionParamsSchema,
  type RsiReversionParams,
} from './rsi-reversion.js';

const PARAMS = {
  rsiPeriod: 3,
  oversold: 30,
  overbought: 70,
  trendPeriod: 5,
  useTrendFilter: false,
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
  overrides: Partial<RsiReversionParams>,
  bars: readonly Candle[],
  position: Position | null = null,
): (Signal | null)[] {
  const params = rsiReversionParamsSchema.parse({ ...PARAMS, ...overrides });
  const indicators = createIndicatorRegistry();
  const prng = mulberry32(1);
  const state = rsiReversion.init(params, { prng, indicators });
  const warmup = rsiReversion.warmupBars(params);

  return bars.map((bar, index) => {
    indicators.updateAll(bar);
    if (index < warmup) {
      return null;
    }
    return rsiReversion.onBar(bar, state, { index, position, indicators, prng });
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

// Caida sostenida deja el RSI en sobreventa; el 90 del indice 7 lo cruza al alza
// sin llegar a superar la SMA de tendencia, que ahi vale 90.8.
const OVERSOLD_BOUNCE = [100, 98, 96, 94, 92, 90, 88, 90, 100, 105];
// Espejo: subida sostenida deja el RSI en sobrecompra y el 105 del indice 7 lo cruza a la baja.
const OVERBOUGHT_FADE = [100, 102, 104, 106, 108, 110, 112, 105, 100, 95];
const FLAT = Array.from({ length: 30 }, () => 100);

describe('rsiReversionParamsSchema', () => {
  it('aplica los defaults documentados', () => {
    expect(rsiReversionParamsSchema.parse({})).toEqual({
      rsiPeriod: 14,
      oversold: 30,
      overbought: 70,
      trendPeriod: 200,
      useTrendFilter: true,
      atrPeriod: 14,
      atrStopMult: 2,
      takeProfitR: 2,
      allowShort: true,
    });
  });

  it('rechaza umbrales cruzados', () => {
    expect(() => rsiReversionParamsSchema.parse({ oversold: 40, overbought: 40 })).toThrow();
    expect(() => rsiReversionParamsSchema.parse({ oversold: 45, overbought: 55 })).not.toThrow();
  });

  it('respeta los minimos y maximos de cada parametro', () => {
    expect(() => rsiReversionParamsSchema.parse({ rsiPeriod: 1 })).toThrow();
    expect(() => rsiReversionParamsSchema.parse({ rsiPeriod: 2.5 })).toThrow();
    expect(() => rsiReversionParamsSchema.parse({ oversold: 0 })).toThrow();
    expect(() => rsiReversionParamsSchema.parse({ overbought: 100 })).toThrow();
    expect(() => rsiReversionParamsSchema.parse({ atrStopMult: 0 })).toThrow();
  });
});

describe('rsiReversion.warmupBars', () => {
  it('cubre el RSI, que necesita rsiPeriod + 1 cierres', () => {
    expect(rsiReversion.warmupBars(rsiReversionParamsSchema.parse({}))).toBe(201);
    expect(
      rsiReversion.warmupBars(
        rsiReversionParamsSchema.parse({ rsiPeriod: 100, trendPeriod: 10, atrPeriod: 5 }),
      ),
    ).toBe(102);
  });
});

describe('rsiReversion.onBar', () => {
  it('cruzar el nivel de sobreventa al alza produce enter long', () => {
    const signals = drive({}, candles(OVERSOLD_BOUNCE));
    const enters = signals
      .map((signal, index) => ({ signal, index }))
      .filter((entry) => entry.signal?.type === 'enter');

    expect(enters).toHaveLength(1);
    expect(enters[0]?.index).toBe(7);
    const signal = enters[0]?.signal;
    if (signal?.type === 'enter') {
      expect(signal.side).toBe('long');
      expect(signal.takeProfitR).toBe(2);
    }
  });

  it('estar en sobreventa sin cruzar todavia no emite nada', () => {
    const signals = drive({}, candles(OVERSOLD_BOUNCE));
    expect(signals[6]).toBeNull();
  });

  it('el stop de un largo queda por debajo del cierre', () => {
    const bars = candles(OVERSOLD_BOUNCE);
    const signals = drive({}, bars);
    const index = signals.findIndex((signal) => signal?.type === 'enter');
    const signal = signals[index];
    const bar = bars[index];
    if (signal?.type === 'enter' && bar !== undefined) {
      expect(signal.stopPrice).toBeLessThan(bar.c);
    }
  });

  it('cruzar el nivel de sobrecompra a la baja produce enter short', () => {
    const signals = drive({}, candles(OVERBOUGHT_FADE));
    const enters = signals
      .map((signal, index) => ({ signal, index }))
      .filter((entry) => entry.signal?.type === 'enter');

    expect(enters).toHaveLength(1);
    expect(enters[0]?.index).toBe(7);
    const signal = enters[0]?.signal;
    if (signal?.type === 'enter') {
      expect(signal.side).toBe('short');
    }
  });

  it('con el filtro de tendencia activo, un rebote contra la tendencia no entra', () => {
    const signals = drive({ useTrendFilter: true }, candles(OVERSOLD_BOUNCE));
    expect(signals.every((signal) => signal === null)).toBe(true);
  });

  it('con allowShort en false no emite ninguna senal short', () => {
    const signals = drive({ allowShort: false }, candles(OVERBOUGHT_FADE));
    for (const signal of signals) {
      if (signal?.type === 'enter' || signal?.type === 'reverse') {
        expect(signal.side).not.toBe('short');
      }
    }
  });

  it('una serie plana deja el RSI en 50 y no emite nada', () => {
    const signals = drive({}, candles(FLAT));
    expect(signals.every((signal) => signal === null)).toBe(true);
  });

  it('una senal contraria con posicion abierta produce reverse', () => {
    const position: Position = { ...OPEN_POSITION, side: 'short', stopPrice: 110 };
    const signals = drive({}, candles(OVERSOLD_BOUNCE), position);
    const reverse = signals.find((signal) => signal?.type === 'reverse');
    expect(reverse).toBeDefined();
    if (reverse?.type === 'reverse') {
      expect(reverse.side).toBe('long');
    }
  });

  it('sin senales durante el warmup', () => {
    const warmup = rsiReversion.warmupBars(rsiReversionParamsSchema.parse(PARAMS));
    const signals = drive({}, candles(OVERSOLD_BOUNCE));
    expect(signals.slice(0, warmup).every((signal) => signal === null)).toBe(true);
  });
});
