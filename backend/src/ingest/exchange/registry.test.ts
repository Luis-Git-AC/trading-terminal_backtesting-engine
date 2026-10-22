import { describe, expect, it } from 'vitest';
import { getAdapter, IMPLEMENTED_EXCHANGES } from './registry.js';
import { AppError } from '../../api/errors.js';

describe('registry de exchanges', () => {
  it('devuelve un adapter funcional por cada id conocido', () => {
    for (const id of IMPLEMENTED_EXCHANGES) {
      const adapter = getAdapter(id);
      expect(adapter.id).toBe(id);
      expect(adapter.maxPageLimit).toBeGreaterThan(0);
      expect(adapter.normalizeSymbol(' btcusdt ')).toBe('BTCUSDT');
    }
  });

  it('lanza AppError con code UNKNOWN_EXCHANGE si el adapter no existe', () => {
    expect(() => getAdapter('nope')).toThrowError(AppError);
    try {
      getAdapter('nope');
      expect.unreachable('deberia haber lanzado');
    } catch (error) {
      expect(error).toMatchObject({ code: 'UNKNOWN_EXCHANGE', status: 404 });
    }
  });

  it('da un rate limiter propio a cada cliente REST, sin compartir instancia', () => {
    const first = getAdapter('hyperliquid').createRestClient({ rps: 5 });
    const second = getAdapter('hyperliquid').createRestClient({ rps: 5 });
    expect(first.limiter).not.toBe(second.limiter);
  });

  it('expone el limite de histórico de cada exchange en el adapter', () => {
    // Binance sirve todo su histórico; Hyperliquid solo las ultimas 5000 velas por serie.
    expect(getAdapter('binance').maxHistoryCandles).toBeNull();
    expect(getAdapter('hyperliquid').maxHistoryCandles).toBe(5000);
  });
});
