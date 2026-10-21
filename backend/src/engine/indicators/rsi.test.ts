import { describe, expect, it } from 'vitest';
import { REFERENCE_CLOSES } from '../../testing/indicator-reference.js';
import { mulberry32 } from '../prng.js';
import { InvalidPeriodError } from './period.js';
import { createRsi } from './rsi.js';

function rsiFrom(avgGain: number, avgLoss: number): number {
  if (avgGain === 0 && avgLoss === 0) {
    return 50;
  }
  if (avgLoss === 0) {
    return 100;
  }
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function naiveRsi(values: readonly number[], period: number): (number | null)[] {
  const out: (number | null)[] = values.map(() => null);
  const gains: number[] = [];
  const losses: number[] = [];

  for (let i = 1; i < values.length; i += 1) {
    const delta = (values[i] ?? 0) - (values[i - 1] ?? 0);
    gains.push(Math.max(0, delta));
    losses.push(Math.max(0, -delta));
  }

  if (gains.length < period) {
    return out;
  }

  let avgGain = 0;
  let avgLoss = 0;
  for (let k = 0; k < period; k += 1) {
    avgGain += gains[k] ?? 0;
    avgLoss += losses[k] ?? 0;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = rsiFrom(avgGain, avgLoss);

  for (let k = period; k < gains.length; k += 1) {
    avgGain = (avgGain * (period - 1) + (gains[k] ?? 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (losses[k] ?? 0)) / period;
    out[k + 1] = rsiFrom(avgGain, avgLoss);
  }

  return out;
}

describe('createRsi', () => {
  it('reproduce el RSI de Wilder sobre la serie de referencia con periodo 5', () => {
    const rsi = createRsi(5);
    const expected = naiveRsi(REFERENCE_CLOSES, 5);
    REFERENCE_CLOSES.forEach((close, index) => {
      const actual = rsi.update(close);
      const reference = expected[index];
      if (reference === null || reference === undefined) {
        expect(actual).toBeNull();
      } else {
        expect(actual ?? Number.NaN).toBeCloseTo(reference, 10);
      }
    });
  });

  it('no esta listo hasta tener n variaciones, es decir n+1 cierres', () => {
    const rsi = createRsi(5);
    for (let i = 0; i < 5; i += 1) {
      expect(rsi.update(REFERENCE_CLOSES[i] ?? 0)).toBeNull();
      expect(rsi.ready).toBe(false);
    }
    expect(rsi.update(REFERENCE_CLOSES[5] ?? 0)).not.toBeNull();
    expect(rsi.ready).toBe(true);
  });

  it('una serie que solo sube da 100', () => {
    const rsi = createRsi(5);
    let last: number | null = null;
    for (let i = 0; i < 20; i += 1) {
      last = rsi.update(10 + i);
    }
    expect(last).toBe(100);
  });

  it('una serie que solo baja da 0', () => {
    const rsi = createRsi(5);
    let last: number | null = null;
    for (let i = 0; i < 20; i += 1) {
      last = rsi.update(100 - i);
    }
    expect(last).toBe(0);
  });

  it('una serie plana da 50, el punto neutro, y no NaN', () => {
    const rsi = createRsi(5);
    let last: number | null = null;
    for (let i = 0; i < 20; i += 1) {
      last = rsi.update(42);
    }
    expect(last).toBe(50);
  });

  it('coincide con la version naive en 5.000 valores con periodo 14', () => {
    const random = mulberry32(1_618_033);
    const values = Array.from({ length: 5_000 }, () => random() * 200 - 100);
    const rsi = createRsi(14);
    const actual = values.map((value) => rsi.update(value));
    const expected = naiveRsi(values, 14);
    actual.forEach((value, index) => {
      const reference = expected[index];
      if (reference === null || reference === undefined) {
        expect(value).toBeNull();
      } else {
        expect(value ?? Number.NaN).toBeCloseTo(reference, 8);
      }
    });
  });

  it('nunca sale del rango 0..100', () => {
    const random = mulberry32(99_991);
    const rsi = createRsi(14);
    for (let i = 0; i < 2_000; i += 1) {
      const value = rsi.update(random() * 1_000);
      if (value !== null) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(100);
      }
    }
  });

  it('rechaza periodos que no son enteros positivos', () => {
    expect(() => createRsi(0)).toThrow(InvalidPeriodError);
    expect(() => createRsi(1.5)).toThrow(InvalidPeriodError);
  });
});
