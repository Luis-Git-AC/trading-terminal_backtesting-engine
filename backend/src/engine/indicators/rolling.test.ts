import { describe, expect, it } from 'vitest';
import {
  REFERENCE_CLOSES,
  REFERENCE_ROLLING_MAX_5,
  REFERENCE_ROLLING_MIN_5,
} from '../../testing/indicator-reference.js';
import { mulberry32 } from '../prng.js';
import { InvalidPeriodError } from './period.js';
import { createRollingMax, createRollingMin } from './rolling.js';

function naiveExtreme(
  values: readonly number[],
  period: number,
  pick: (window: number[]) => number,
): (number | null)[] {
  return values.map((_, index) =>
    index + 1 < period ? null : pick(values.slice(index - period + 1, index + 1)),
  );
}

describe('createRollingMax', () => {
  it('reproduce la serie de referencia con periodo 5', () => {
    const rolling = createRollingMax(5);
    REFERENCE_CLOSES.forEach((close, index) => {
      expect(rolling.update(close)).toBe(REFERENCE_ROLLING_MAX_5[index] ?? null);
    });
  });

  it('no esta listo hasta la muestra n', () => {
    const rolling = createRollingMax(3);
    expect(rolling.update(1)).toBeNull();
    expect(rolling.ready).toBe(false);
    expect(rolling.update(2)).toBeNull();
    expect(rolling.update(3)).toBe(3);
    expect(rolling.ready).toBe(true);
  });

  it('deja caer el maximo cuando sale de la ventana', () => {
    const rolling = createRollingMax(3);
    rolling.update(100);
    rolling.update(1);
    expect(rolling.update(2)).toBe(100);
    expect(rolling.update(3)).toBe(3);
  });

  it('coincide con la version naive en 10.000 valores con ventana 500', () => {
    const random = mulberry32(20_260_812);
    const values = Array.from({ length: 10_000 }, () => random() * 1000 - 500);
    const rolling = createRollingMax(500);
    const actual = values.map((value) => rolling.update(value));
    const expected = naiveExtreme(values, 500, (window) => Math.max(...window));
    expect(actual).toEqual(expected);
  });

  it('repetir el mismo valor no descoloca la ventana', () => {
    const repeated = [4, 4, 4, 4, 1, 1, 1, 1, 9, 9, 2, 2];
    const rolling = createRollingMax(3);
    const actual = repeated.map((value) => rolling.update(value));
    expect(actual).toEqual(naiveExtreme(repeated, 3, (window) => Math.max(...window)));
  });

  it('con periodo 1 es la identidad', () => {
    const rolling = createRollingMax(1);
    expect(rolling.update(5)).toBe(5);
    expect(rolling.update(-2)).toBe(-2);
  });

  it('rechaza periodos invalidos', () => {
    expect(() => createRollingMax(0)).toThrow(InvalidPeriodError);
  });
});

describe('createRollingMin', () => {
  it('reproduce la serie de referencia con periodo 5', () => {
    const rolling = createRollingMin(5);
    REFERENCE_CLOSES.forEach((close, index) => {
      expect(rolling.update(close)).toBe(REFERENCE_ROLLING_MIN_5[index] ?? null);
    });
  });

  it('deja caer el minimo cuando sale de la ventana', () => {
    const rolling = createRollingMin(3);
    rolling.update(-100);
    rolling.update(1);
    expect(rolling.update(2)).toBe(-100);
    expect(rolling.update(3)).toBe(1);
  });

  it('coincide con la version naive en 10.000 valores con ventana 500', () => {
    const random = mulberry32(31_415_926);
    const values = Array.from({ length: 10_000 }, () => random() * 1000 - 500);
    const rolling = createRollingMin(500);
    const actual = values.map((value) => rolling.update(value));
    const expected = naiveExtreme(values, 500, (window) => Math.min(...window));
    expect(actual).toEqual(expected);
  });

  it('get() devuelve lo mismo que el ultimo update()', () => {
    const rolling = createRollingMin(4);
    for (const close of REFERENCE_CLOSES) {
      const returned = rolling.update(close);
      expect(rolling.get()).toBe(returned);
    }
  });

  it('get() es null antes de calentar y no cambia sin update()', () => {
    const rolling = createRollingMin(3);
    expect(rolling.get()).toBeNull();
    rolling.update(5);
    expect(rolling.get()).toBeNull();
    rolling.update(4);
    rolling.update(6);
    expect(rolling.get()).toBe(4);
    expect(rolling.get()).toBe(4);
  });
});
