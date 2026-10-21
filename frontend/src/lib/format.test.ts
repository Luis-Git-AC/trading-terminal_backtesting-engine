import { describe, expect, it } from 'vitest';
import {
  formatCount,
  formatNumber,
  formatPercent,
  formatSignedPercent,
  formatUsd,
} from '@/lib/format';

describe('formato numerico de la terminal', () => {
  it('los importes van en dolares, con coma de miles y punto decimal', () => {
    expect(formatUsd(66_418.2)).toBe('$66,418.20');
    expect(formatUsd(-2_596.23)).toBe('-$2,596.23');
    expect(formatUsd(10_400, 0)).toBe('$10,400');
  });

  it('los recuentos agrupan tambien los de cuatro cifras', () => {
    expect(formatCount(2_000)).toBe('2,000');
    expect(formatCount(63_267)).toBe('63,267');
  });

  it('ratios y porcentajes usan el mismo separador decimal que los importes', () => {
    expect(formatNumber(1.61)).toBe('1.61');
    expect(formatPercent(25.96)).toBe('25.96%');
    expect(formatSignedPercent(2.1818)).toBe('+2.18%');
    expect(formatSignedPercent(-1.5)).toBe('-1.50%');
    expect(formatSignedPercent(0)).toBe('0.00%');
  });
});
