import type { Candle } from '@tt/shared';
import { describe, expect, it } from 'vitest';
import { createIndicatorRegistry } from '../engine/indicators/registry.js';
import { mulberry32 } from '../engine/prng.js';
import type { Position, Signal } from '../engine/types.js';
import {
  bollingerReversion,
  bollingerReversionParamsSchema,
  type BollingerReversionParams,
} from './bollinger-reversion.js';

const PARAMS = {
  period: 5,
  stdMult: 1.5,
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
  overrides: Partial<BollingerReversionParams>,
  bars: readonly Candle[],
  position: Position | null = null,
): (Signal | null)[] {
  const params = bollingerReversionParamsSchema.parse({ ...PARAMS, ...overrides });
  const indicators = createIndicatorRegistry();
  const prng = mulberry32(1);
  const state = bollingerReversion.init(params, { prng, indicators });
  const warmup = bollingerReversion.warmupBars(params);

  return bars.map((bar, index) => {
    indicators.updateAll(bar);
    if (index < warmup) {
      return null;
    }
    return bollingerReversion.onBar(bar, state, { index, position, indicators, prng });
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

// El cierre 80 del indice 8 perfora la banda inferior; el 100 del indice 9 vuelve a entrar.
const DIP_AND_RECOVER = [100, 100, 100, 100, 100, 99, 98, 97, 80, 100, 100];
// Espejo: el 120 del indice 8 perfora la banda superior y el 100 del 9 vuelve a entrar.
const SPIKE_AND_FADE = [100, 100, 100, 100, 100, 101, 102, 103, 120, 100, 100];
const FLAT = Array.from({ length: 30 }, () => 100);

describe('bollingerReversionParamsSchema', () => {
  it('aplica los defaults documentados', () => {
    expect(bollingerReversionParamsSchema.parse({})).toEqual({
      period: 20,
      stdMult: 2,
      atrPeriod: 14,
      atrStopMult: 2,
      takeProfitR: 2,
      allowShort: true,
    });
  });

  it('respeta los minimos y maximos de cada parametro', () => {
    expect(() => bollingerReversionParamsSchema.parse({ period: 1 })).toThrow();
    expect(() => bollingerReversionParamsSchema.parse({ period: 201 })).toThrow();
    expect(() => bollingerReversionParamsSchema.parse({ period: 2.5 })).toThrow();
    expect(() => bollingerReversionParamsSchema.parse({ stdMult: 0 })).toThrow();
    expect(() => bollingerReversionParamsSchema.parse({ atrStopMult: 0 })).toThrow();
    expect(() => bollingerReversionParamsSchema.parse({ takeProfitR: 25 })).toThrow();
  });
});

describe('bollingerReversion.warmupBars', () => {
  it('es max(period, atrPeriod) + 1', () => {
    expect(bollingerReversion.warmupBars(bollingerReversionParamsSchema.parse({}))).toBe(21);
    expect(
      bollingerReversion.warmupBars(
        bollingerReversionParamsSchema.parse({ period: 10, atrPeriod: 50 }),
      ),
    ).toBe(51);
  });
});

describe('bollingerReversion.onBar', () => {
  it('volver a entrar en la banda inferior produce una senal enter long', () => {
    const signals = drive({}, candles(DIP_AND_RECOVER));
    const enters = signals
      .map((signal, index) => ({ signal, index }))
      .filter((entry) => entry.signal?.type === 'enter');

    expect(enters).toHaveLength(1);
    expect(enters[0]?.index).toBe(9);
    const signal = enters[0]?.signal;
    if (signal?.type === 'enter') {
      expect(signal.side).toBe('long');
      expect(signal.takeProfitR).toBe(2);
    }
  });

  it('no entra en la barra que perfora la banda, solo cuando vuelve dentro', () => {
    const signals = drive({}, candles(DIP_AND_RECOVER));
    expect(signals[8]).toBeNull();
  });

  it('el stop de un largo queda por debajo del cierre', () => {
    const bars = candles(DIP_AND_RECOVER);
    const signals = drive({}, bars);
    const index = signals.findIndex((signal) => signal?.type === 'enter');
    const signal = signals[index];
    const bar = bars[index];
    if (signal?.type === 'enter' && bar !== undefined) {
      expect(signal.stopPrice).toBeLessThan(bar.c);
    }
  });

  it('volver a entrar en la banda superior produce una senal enter short', () => {
    const signals = drive({}, candles(SPIKE_AND_FADE));
    const enters = signals
      .map((signal, index) => ({ signal, index }))
      .filter((entry) => entry.signal?.type === 'enter');

    expect(enters).toHaveLength(1);
    expect(enters[0]?.index).toBe(9);
    const signal = enters[0]?.signal;
    if (signal?.type === 'enter') {
      expect(signal.side).toBe('short');
      expect(signal.stopPrice).toBeGreaterThan(100);
    }
  });

  it('con allowShort en false no emite ninguna senal short', () => {
    const signals = drive({ allowShort: false }, candles(SPIKE_AND_FADE));
    for (const signal of signals) {
      if (signal?.type === 'enter' || signal?.type === 'reverse') {
        expect(signal.side).not.toBe('short');
      }
    }
  });

  it('una serie plana no toca las bandas y no emite nada', () => {
    const signals = drive({}, candles(FLAT));
    expect(signals.every((signal) => signal === null)).toBe(true);
  });

  it('una senal contraria con posicion abierta produce reverse', () => {
    const position: Position = { ...OPEN_POSITION, side: 'short', stopPrice: 110 };
    const signals = drive({}, candles(DIP_AND_RECOVER), position);
    const reverse = signals.find((signal) => signal?.type === 'reverse');
    expect(reverse).toBeDefined();
    if (reverse?.type === 'reverse') {
      expect(reverse.side).toBe('long');
    }
  });

  it('una senal del mismo lado que la posicion abierta no emite nada', () => {
    const position: Position = { ...OPEN_POSITION, side: 'long', stopPrice: 90 };
    const signals = drive({}, candles(DIP_AND_RECOVER), position);
    expect(signals.every((signal) => signal === null)).toBe(true);
  });

  it('sin senales durante el warmup', () => {
    const warmup = bollingerReversion.warmupBars(bollingerReversionParamsSchema.parse(PARAMS));
    const signals = drive({}, candles(DIP_AND_RECOVER));
    expect(signals.slice(0, warmup).every((signal) => signal === null)).toBe(true);
  });
});
