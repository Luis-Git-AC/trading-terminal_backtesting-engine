import { describe, expect, it } from 'vitest';
import { REFERENCE_CLOSES, REFERENCE_EMA_5 } from '../../testing/indicator-reference.js';
import { createEma } from './ema.js';
import { InvalidPeriodError } from './period.js';

describe('createEma', () => {
  it('reproduce la serie de referencia de 20 valores con periodo 5', () => {
    const ema = createEma(5);
    REFERENCE_CLOSES.forEach((close, index) => {
      const actual = ema.update(close);
      const expected = REFERENCE_EMA_5[index];
      if (expected === null || expected === undefined) {
        expect(actual).toBeNull();
      } else {
        expect(actual ?? Number.NaN).toBeCloseTo(expected, 10);
      }
    });
  });

  it('siembra con la SMA de los primeros n, no con el primer valor', () => {
    const ema = createEma(5);
    let seeded: number | null = null;
    for (let i = 0; i < 5; i += 1) {
      seeded = ema.update(REFERENCE_CLOSES[i] ?? 0);
    }
    const firstFive = REFERENCE_CLOSES.slice(0, 5);
    const sma = firstFive.reduce((total, value) => total + value, 0) / 5;
    expect(seeded ?? Number.NaN).toBeCloseTo(sma, 12);
    expect(seeded).not.toBe(REFERENCE_CLOSES[0]);
  });

  it('aplica el factor de suavizado 2/(n+1) tras la semilla', () => {
    const ema = createEma(5);
    for (let i = 0; i < 5; i += 1) {
      ema.update(REFERENCE_CLOSES[i] ?? 0);
    }
    const seed = ema.get() ?? Number.NaN;
    const next = REFERENCE_CLOSES[5] ?? 0;
    const expected = seed + (2 / 6) * (next - seed);
    expect(ema.update(next) ?? Number.NaN).toBeCloseTo(expected, 12);
  });

  it('no esta listo hasta la muestra n', () => {
    const ema = createEma(5);
    for (let i = 0; i < 4; i += 1) {
      expect(ema.update(REFERENCE_CLOSES[i] ?? 0)).toBeNull();
      expect(ema.ready).toBe(false);
    }
    expect(ema.update(REFERENCE_CLOSES[4] ?? 0)).not.toBeNull();
    expect(ema.ready).toBe(true);
  });

  it('con periodo 1 sigue al valor de entrada', () => {
    const ema = createEma(1);
    expect(ema.update(7)).toBe(7);
    expect(ema.update(9)).toBe(9);
  });

  it('converge hacia una entrada constante', () => {
    const ema = createEma(5);
    for (let i = 0; i < 500; i += 1) {
      ema.update(42);
    }
    expect(ema.get() ?? Number.NaN).toBeCloseTo(42, 10);
  });

  it('repetir el mismo valor no descoloca el estado interno', () => {
    const ema = createEma(3);
    for (let i = 0; i < 3; i += 1) {
      ema.update(10);
    }
    expect(ema.get()).toBe(10);
    expect(ema.update(10)).toBe(10);
  });

  it('rechaza periodos que no son enteros positivos', () => {
    expect(() => createEma(0)).toThrow(InvalidPeriodError);
    expect(() => createEma(1.5)).toThrow(InvalidPeriodError);
  });
});
