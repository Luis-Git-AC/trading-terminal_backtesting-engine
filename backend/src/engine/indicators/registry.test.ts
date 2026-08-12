import { describe, expect, it } from 'vitest';
import { REFERENCE_CANDLES, REFERENCE_SMA_5 } from '../../testing/indicator-reference.js';
import { createAtr } from './atr.js';
import {
  DuplicateIndicatorError,
  UnknownIndicatorError,
  createIndicatorRegistry,
  fromBar,
  fromClose,
} from './registry.js';
import { createSma } from './sma.js';

describe('createIndicatorRegistry', () => {
  it('actualiza todos los indicadores con una sola llamada por barra', () => {
    const registry = createIndicatorRegistry();
    registry.register('sma5', createSma(5), fromClose);
    registry.register('atr5', createAtr(5), fromBar);

    REFERENCE_CANDLES.forEach((bar, index) => {
      registry.updateAll(bar);
      const expected = REFERENCE_SMA_5[index];
      if (expected === null || expected === undefined) {
        expect(registry.get('sma5')).toBeNull();
      } else {
        expect(registry.get('sma5') ?? Number.NaN).toBeCloseTo(expected, 10);
      }
    });
    expect(registry.get('atr5')).not.toBeNull();
  });

  it('conserva el orden de registro, que es lo que hace determinista el recorrido', () => {
    const registry = createIndicatorRegistry();
    registry.register('zeta', createSma(2), fromClose);
    registry.register('alfa', createSma(3), fromClose);
    registry.register('media', createSma(4), fromClose);
    expect(registry.keys).toEqual(['zeta', 'alfa', 'media']);
  });

  it('cada indicador recibe solo lo que su selector extrae', () => {
    const registry = createIndicatorRegistry();
    registry.register('sma2', createSma(2), fromClose);
    const first = REFERENCE_CANDLES[0];
    const second = REFERENCE_CANDLES[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) {
      return;
    }
    registry.updateAll(first);
    registry.updateAll(second);
    expect(registry.get('sma2') ?? Number.NaN).toBeCloseTo((first.c + second.c) / 2, 12);
  });

  it('ready() refleja el calentamiento de cada indicador por separado', () => {
    const registry = createIndicatorRegistry();
    registry.register('sma2', createSma(2), fromClose);
    registry.register('sma10', createSma(10), fromClose);

    expect(registry.ready('sma2')).toBe(false);
    expect(registry.allReady).toBe(false);

    for (const bar of REFERENCE_CANDLES.slice(0, 3)) {
      registry.updateAll(bar);
    }
    expect(registry.ready('sma2')).toBe(true);
    expect(registry.ready('sma10')).toBe(false);
    expect(registry.allReady).toBe(false);

    for (const bar of REFERENCE_CANDLES.slice(3, 10)) {
      registry.updateAll(bar);
    }
    expect(registry.allReady).toBe(true);
  });

  it('rechaza registrar dos veces la misma clave', () => {
    const registry = createIndicatorRegistry();
    registry.register('sma5', createSma(5), fromClose);
    expect(() => registry.register('sma5', createSma(9), fromClose)).toThrow(
      DuplicateIndicatorError,
    );
  });

  it('consultar una clave desconocida falla en vez de devolver null', () => {
    const registry = createIndicatorRegistry();
    registry.register('sma5', createSma(5), fromClose);
    expect(() => registry.get('ema9')).toThrow(UnknownIndicatorError);
    expect(() => registry.ready('ema9')).toThrow(UnknownIndicatorError);
    expect(() => registry.get('ema9')).toThrow(/sma5/);
  });

  it('un registro vacio se actualiza sin quejarse', () => {
    const registry = createIndicatorRegistry();
    const first = REFERENCE_CANDLES[0];
    if (first === undefined) {
      return;
    }
    expect(() => registry.updateAll(first)).not.toThrow();
    expect(registry.keys).toEqual([]);
    expect(registry.allReady).toBe(true);
  });
});
