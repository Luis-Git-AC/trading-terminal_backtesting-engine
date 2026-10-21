import { describe, expect, it } from 'vitest';
import { SERIES_COLORS, seriesColor } from '@/components/Compare/CompareView';

describe('seriesColor', () => {
  it('cada run del comparador tiene un color propio, distinto del verde y el rojo de mercado', () => {
    const colors = [0, 1, 2, 3].map(seriesColor);

    expect(new Set(colors).size).toBe(4);
    expect(colors.every((color) => color.startsWith('var(--color-series-'))).toBe(true);
  });

  it('el color de un run es estable y se repite en ciclo si hubiera mas series que colores', () => {
    expect(seriesColor(1)).toBe(seriesColor(1));
    expect(seriesColor(SERIES_COLORS.length)).toBe(seriesColor(0));
  });
});
