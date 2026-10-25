import { describe, expect, it } from 'vitest';
import { sampleEvenly } from './run-results.js';

describe('sampleEvenly', () => {
  it('no toca una serie que ya cabe', () => {
    expect(sampleEvenly([1, 2, 3], 5)).toEqual([1, 2, 3]);
  });

  it('reduce a max puntos conservando el primero y el ultimo, en orden', () => {
    const points = Array.from({ length: 1_000 }, (_, i) => i);
    const sample = sampleEvenly(points, 10);
    expect(sample).toHaveLength(10);
    expect(sample[0]).toBe(0);
    expect(sample.at(-1)).toBe(999);
    expect([...sample].sort((x, y) => x - y)).toEqual(sample);
  });
});
