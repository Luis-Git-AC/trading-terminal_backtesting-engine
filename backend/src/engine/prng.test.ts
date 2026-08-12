import { describe, expect, it } from 'vitest';
import { mulberry32 } from './prng.js';

const GOLDEN_SEED_42 = [
  0.6011037519201636, 0.44829055899754167, 0.8524657934904099, 0.6697340414393693,
  0.17481389874592423,
] as const;

const GOLDEN_SEED_7 = [0.011704753153026104, 0.06195825757458806, 0.97690763277933] as const;

function take(next: () => number, count: number): number[] {
  const values: number[] = [];
  for (let i = 0; i < count; i += 1) {
    values.push(next());
  }
  return values;
}

describe('mulberry32', () => {
  it('coincide con los golden values de la semilla 42', () => {
    expect(take(mulberry32(42), 5)).toEqual([...GOLDEN_SEED_42]);
  });

  it('coincide con los golden values de la semilla 7', () => {
    expect(take(mulberry32(7), 3)).toEqual([...GOLDEN_SEED_7]);
  });

  it('la misma semilla produce la misma secuencia en dos instancias', () => {
    expect(take(mulberry32(42), 100)).toEqual(take(mulberry32(42), 100));
  });

  it('semillas distintas divergen', () => {
    expect(take(mulberry32(42), 10)).not.toEqual(take(mulberry32(43), 10));
  });

  it('cada instancia lleva su propio estado', () => {
    const first = mulberry32(42);
    first();
    const second = mulberry32(42);
    expect(second()).toBe(GOLDEN_SEED_42[0]);
    expect(first()).toBe(GOLDEN_SEED_42[1]);
  });

  it('devuelve valores en [0, 1)', () => {
    for (const seed of [0, 1, 42, 12_345, 2 ** 31, 4_294_967_295]) {
      for (const value of take(mulberry32(seed), 500)) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(1);
      }
    }
  });

  it('normaliza la semilla a uint32: -1 y 4294967295 son la misma', () => {
    expect(take(mulberry32(-1), 5)).toEqual(take(mulberry32(4_294_967_295), 5));
  });

  it('no se estanca ni se repite en 10.000 tiradas', () => {
    const values = take(mulberry32(42), 10_000);
    expect(new Set(values).size).toBe(values.length);
  });
});
