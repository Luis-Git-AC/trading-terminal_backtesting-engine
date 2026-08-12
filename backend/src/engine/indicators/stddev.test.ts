import { describe, expect, it } from 'vitest';
import { REFERENCE_CLOSES, REFERENCE_STDDEV_5 } from '../../testing/indicator-reference.js';
import { mulberry32 } from '../prng.js';
import { InvalidPeriodError } from './period.js';
import { createStdDev } from './stddev.js';

function naiveStdDev(values: readonly number[], period: number): (number | null)[] {
  return values.map((_, index) => {
    if (index + 1 < period) {
      return null;
    }
    const window = values.slice(index - period + 1, index + 1);
    const mean = window.reduce((a, b) => a + b, 0) / period;
    const variance = window.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
    return Math.sqrt(variance);
  });
}

describe('createStdDev', () => {
  it('reproduce la serie de referencia de 20 valores con periodo 5', () => {
    const stddev = createStdDev(5);
    REFERENCE_CLOSES.forEach((close, index) => {
      const actual = stddev.update(close);
      const expected = REFERENCE_STDDEV_5[index];
      if (expected === null || expected === undefined) {
        expect(actual).toBeNull();
      } else {
        expect(actual ?? Number.NaN).toBeCloseTo(expected, 10);
      }
    });
  });

  it('no esta listo hasta la muestra n', () => {
    const stddev = createStdDev(4);
    for (let i = 0; i < 3; i += 1) {
      expect(stddev.update(REFERENCE_CLOSES[i] ?? 0)).toBeNull();
      expect(stddev.ready).toBe(false);
    }
    expect(stddev.update(REFERENCE_CLOSES[3] ?? 0)).not.toBeNull();
    expect(stddev.ready).toBe(true);
  });

  it('una serie constante da desviacion exactamente 0, sin negativos por redondeo', () => {
    const stddev = createStdDev(5);
    let last: number | null = null;
    for (let i = 0; i < 100; i += 1) {
      last = stddev.update(1_000_000.123456);
    }
    expect(last).toBe(0);
  });

  it('coincide con la version naive en 5.000 valores con ventana 50', () => {
    const random = mulberry32(2_718_281);
    const values = Array.from({ length: 5_000 }, () => random() * 200 - 100);
    const stddev = createStdDev(50);
    const actual = values.map((value) => stddev.update(value));
    const expected = naiveStdDev(values, 50);
    actual.forEach((value, index) => {
      const reference = expected[index];
      if (reference === null || reference === undefined) {
        expect(value).toBeNull();
      } else {
        expect(value ?? Number.NaN).toBeCloseTo(reference, 8);
      }
    });
  });

  it('aguanta valores grandes sin perder precision', () => {
    const values = [1e9 + 4, 1e9 + 7, 1e9 + 13, 1e9 + 16];
    const stddev = createStdDev(4);
    let last: number | null = null;
    for (const value of values) {
      last = stddev.update(value);
    }
    const expected = naiveStdDev(values, 4)[3];
    expect(last ?? Number.NaN).toBeCloseTo(expected ?? Number.NaN, 8);
  });

  it('repetir el mismo valor no descoloca el estado interno', () => {
    const repeated = [3, 3, 3, 8, 8, 8, 3, 3, 1, 1, 1, 1];
    const stddev = createStdDev(4);
    const actual = repeated.map((value) => stddev.update(value));
    const expected = naiveStdDev(repeated, 4);
    actual.forEach((value, index) => {
      const reference = expected[index];
      if (reference === null || reference === undefined) {
        expect(value).toBeNull();
      } else {
        expect(value ?? Number.NaN).toBeCloseTo(reference, 10);
      }
    });
  });

  it('con periodo 1 la desviacion es siempre 0', () => {
    const stddev = createStdDev(1);
    expect(stddev.update(5)).toBe(0);
    expect(stddev.update(-99)).toBe(0);
  });

  it('rechaza periodos invalidos', () => {
    expect(() => createStdDev(0)).toThrow(InvalidPeriodError);
  });
});
