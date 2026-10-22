import { describe, expect, it } from 'vitest';
import { EXCHANGES } from '@tt/shared';
import { AppError } from '../../api/errors.js';
import { getAdapter } from './registry.js';

describe('registry de exchanges', () => {
  it('devuelve un adapter funcional por cada id conocido', () => {
    for (const id of EXCHANGES) {
      const adapter = getAdapter(id);
      expect(adapter.id).toBe(id);
      expect(adapter.maxPageLimit).toBeGreaterThan(0);
      expect(adapter.normalizeSymbol(' btcusdt ')).toBe('BTCUSDT');
    }
  });

  it('lanza AppError con code UNKNOWN_EXCHANGE si el id no existe', () => {
    expect(() => getAdapter('nope')).toThrowError(AppError);
    try {
      getAdapter('nope');
      expect.unreachable('deberia haber lanzado');
    } catch (error) {
      expect(error).toMatchObject({ code: 'UNKNOWN_EXCHANGE', status: 404 });
    }
  });

  it('da un rate limiter propio a cada cliente REST, sin compartir instancia', () => {
    const first = getAdapter('bitget').createRestClient({ rps: 5 });
    const second = getAdapter('bitget').createRestClient({ rps: 5 });
    expect(first.limiter).not.toBe(second.limiter);
  });

  it('expone el limite de histórico de cada exchange en el adapter', () => {
    expect(getAdapter('bitget').maxHistoryCandles).toBeNull();
  });
});
