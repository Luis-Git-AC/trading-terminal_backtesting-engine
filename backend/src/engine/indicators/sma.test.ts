import { describe, expect, it } from 'vitest';
import { REFERENCE_CLOSES, REFERENCE_SMA_5 } from '../../testing/indicator-reference.js';
import { InvalidPeriodError } from './period.js';
import { createSma } from './sma.js';

function naiveSma(values: readonly number[], period: number): (number | null)[] {
  return values.map((_, index) => {
    if (index + 1 < period) {
      return null;
    }
    const window = values.slice(index - period + 1, index + 1);
    return window.reduce((total, value) => total + value, 0) / period;
  });
}

describe('createSma', () => {
  it('reproduce la serie de referencia de 20 valores con periodo 5', () => {
    const sma = createSma(5);
    REFERENCE_CLOSES.forEach((close, index) => {
      const actual = sma.update(close);
      const expected = REFERENCE_SMA_5[index];
      if (expected === null || expected === undefined) {
        expect(actual).toBeNull();
      } else {
        expect(actual).not.toBeNull();
        expect(actual ?? Number.NaN).toBeCloseTo(expected, 10);
      }
    });
  });

  it('no esta listo hasta la muestra n y lo esta desde ahi', () => {
    const sma = createSma(5);
    for (let i = 0; i < 4; i += 1) {
      expect(sma.update(REFERENCE_CLOSES[i] ?? 0)).toBeNull();
      expect(sma.ready).toBe(false);
    }
    expect(sma.update(REFERENCE_CLOSES[4] ?? 0)).not.toBeNull();
    expect(sma.ready).toBe(true);
  });

  it('get() devuelve lo mismo que el ultimo update()', () => {
    const sma = createSma(3);
    for (const close of REFERENCE_CLOSES) {
      const returned = sma.update(close);
      expect(sma.get()).toBe(returned);
    }
  });

  it('get() es null antes de calentar', () => {
    const sma = createSma(3);
    expect(sma.get()).toBeNull();
    sma.update(1);
    expect(sma.get()).toBeNull();
  });

  it('con periodo 1 es la identidad', () => {
    const sma = createSma(1);
    expect(sma.update(7)).toBe(7);
    expect(sma.update(-3)).toBe(-3);
  });

  it('repetir el mismo valor no descoloca el estado interno', () => {
    const repeated = [5, 5, 5, 5, 5, 9, 9, 2, 2, 2, 7, 7, 7, 7];
    const sma = createSma(4);
    const actual = repeated.map((value) => sma.update(value));
    const expected = naiveSma(repeated, 4);
    actual.forEach((value, index) => {
      const reference = expected[index];
      if (reference === null || reference === undefined) {
        expect(value).toBeNull();
      } else {
        expect(value ?? Number.NaN).toBeCloseTo(reference, 10);
      }
    });
  });

  it('la ventana olvida de verdad los valores que salen', () => {
    const sma = createSma(2);
    sma.update(1000);
    sma.update(0);
    expect(sma.update(0)).toBe(0);
  });

  it('rechaza periodos que no son enteros positivos', () => {
    expect(() => createSma(0)).toThrow(InvalidPeriodError);
    expect(() => createSma(-1)).toThrow(InvalidPeriodError);
    expect(() => createSma(2.5)).toThrow(InvalidPeriodError);
    expect(() => createSma(Number.NaN)).toThrow(InvalidPeriodError);
  });
});
