import { describe, expect, it } from 'vitest';
import { symbolSchema } from './api-schemas.js';

describe('symbolSchema', () => {
  it('acepta pares, simbolos sueltos y mercados con prefijo de dex', () => {
    for (const value of ['BTC', 'BTCUSDT', 'XAUUSDT', 'XYZ:GOLD']) {
      expect(symbolSchema.parse(value)).toBe(value);
    }
  });

  it('pasa a mayusculas antes de validar', () => {
    expect(symbolSchema.parse('btc')).toBe('BTC');
    expect(symbolSchema.parse('xyz:gold')).toBe('XYZ:GOLD');
  });

  it('rechaza todo lo que no sea alfanumerico en el rango admitido', () => {
    for (const value of ['btc usdt', 'BTC/USDT', 'A', '', 'A'.repeat(40), ':GOLD', 'XYZ:']) {
      expect(symbolSchema.safeParse(value).success).toBe(false);
    }
  });
});
