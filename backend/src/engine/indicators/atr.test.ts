import type { Candle } from '@tt/shared';
import { describe, expect, it } from 'vitest';
import {
  REFERENCE_ATR_5,
  REFERENCE_CANDLES,
  REFERENCE_TRUE_RANGE,
} from '../../testing/indicator-reference.js';
import type { Indicator } from '../types.js';
import { createAtr, trueRange } from './atr.js';
import { InvalidPeriodError } from './period.js';

function feed(atr: Indicator<Candle>, count: number): number | null {
  let last: number | null = null;
  for (const bar of REFERENCE_CANDLES.slice(0, count)) {
    last = atr.update(bar);
  }
  return last;
}

describe('trueRange', () => {
  it('sin cierre previo es simplemente high - low', () => {
    expect(trueRange({ t: 0, o: 10, h: 12, l: 9, c: 11, v: 1 }, null)).toBe(3);
  });

  it('toma el mayor de los tres candidatos', () => {
    const bar: Candle = { t: 0, o: 10, h: 12, l: 11, c: 11.5, v: 1 };
    expect(trueRange(bar, 5)).toBe(7);
    expect(trueRange(bar, 20)).toBe(9);
    expect(trueRange(bar, 11.5)).toBe(1);
  });

  it('reproduce la serie de referencia de true range', () => {
    let previousClose: number | null = null;
    REFERENCE_CANDLES.forEach((bar, index) => {
      expect(trueRange(bar, previousClose)).toBeCloseTo(REFERENCE_TRUE_RANGE[index] ?? 0, 10);
      previousClose = bar.c;
    });
  });
});

describe('createAtr', () => {
  it('reproduce la serie de referencia de 20 velas con periodo 5 (Wilder)', () => {
    const atr = createAtr(5);
    REFERENCE_CANDLES.forEach((bar, index) => {
      const actual = atr.update(bar);
      const expected = REFERENCE_ATR_5[index];
      if (expected === null || expected === undefined) {
        expect(actual).toBeNull();
      } else {
        expect(actual ?? Number.NaN).toBeCloseTo(expected, 10);
      }
    });
  });

  it('siembra con la media simple de los primeros n true ranges', () => {
    const seeded = feed(createAtr(5), 5);
    const mean = REFERENCE_TRUE_RANGE.slice(0, 5).reduce((a, b) => a + b, 0) / 5;
    expect(seeded ?? Number.NaN).toBeCloseTo(mean, 12);
  });

  it('suaviza con la formula de Wilder tras la semilla', () => {
    const atr = createAtr(5);
    const seed = feed(atr, 5) ?? Number.NaN;
    const expected = (seed * 4 + (REFERENCE_TRUE_RANGE[5] ?? 0)) / 5;
    const sixth = REFERENCE_CANDLES[5];
    expect(sixth).toBeDefined();
    expect(sixth === undefined ? Number.NaN : (atr.update(sixth) ?? Number.NaN)).toBeCloseTo(
      expected,
      10,
    );
  });

  it('no esta listo hasta la vela n', () => {
    const atr = createAtr(5);
    expect(feed(atr, 4)).toBeNull();
    expect(atr.ready).toBe(false);
    expect(feed(createAtr(5), 5)).not.toBeNull();
    expect(createAtr(1).ready).toBe(false);
  });

  it('una serie de rango constante converge a ese rango', () => {
    const atr = createAtr(3);
    for (let i = 0; i < 200; i += 1) {
      atr.update({ t: i, o: 10, h: 11, l: 10, c: 10, v: 1 });
    }
    expect(atr.get() ?? Number.NaN).toBeCloseTo(1, 8);
  });

  it('rechaza periodos que no son enteros positivos', () => {
    expect(() => createAtr(0)).toThrow(InvalidPeriodError);
  });
});
