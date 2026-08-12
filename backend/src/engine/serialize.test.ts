import { describe, expect, it } from 'vitest';
import {
  NonSerializableValueError,
  canonicalize,
  hashResult,
  serializeCanonical,
  sha256,
} from './serialize.js';
import { ENGINE_VERSION, type BacktestResult } from './types.js';

function makeResult(overrides: Partial<BacktestResult> = {}): BacktestResult {
  return {
    engineVersion: ENGINE_VERSION,
    metrics: {
      netProfit: 1843.21,
      netProfitPct: 18.43,
      maxDrawdown: 0.121,
      maxDrawdownQuote: 1204.55,
      winRate: 0.42,
      profitFactor: 1.61,
      expectancyR: 0.23,
      trades: 2,
      wins: 1,
      losses: 1,
      avgWinR: 1.82,
      avgLossR: -0.98,
      largestWinR: 1.82,
      largestLossR: -0.98,
      exposurePct: 34.2,
      barsTotal: 100,
      openAtEnd: false,
    },
    trades: [],
    equityCurve: [{ t: 1_785_000_000_000, equity: 10_000, drawdown: 0 }],
    rejectedSignals: 0,
    ...overrides,
  };
}

describe('serializeCanonical', () => {
  it('el orden de las claves no cambia el resultado', () => {
    const a = { beta: 2, alpha: 1, gamma: { z: 3, a: 4 } };
    const b = { gamma: { a: 4, z: 3 }, alpha: 1, beta: 2 };
    expect(serializeCanonical(a)).toBe(serializeCanonical(b));
    expect(serializeCanonical(a)).toBe('{"alpha":1,"beta":2,"gamma":{"a":4,"z":3}}');
  });

  it('conserva el orden de los arrays, que si es significativo', () => {
    expect(serializeCanonical([3, 1, 2])).toBe('[3,1,2]');
    expect(serializeCanonical([1, 2, 3])).not.toBe(serializeCanonical([3, 2, 1]));
  });

  it('redondea todos los numeros a 10 decimales', () => {
    expect(serializeCanonical({ x: 0.1 + 0.2 })).toBe('{"x":0.3}');
    expect(serializeCanonical({ x: 1 / 3 })).toBe('{"x":0.3333333333}');
  });

  it('descarta las claves undefined en vez de emitirlas', () => {
    expect(serializeCanonical({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('atraviesa null, booleanos y strings sin tocarlos', () => {
    expect(serializeCanonical({ a: null, b: true, c: 'x' })).toBe('{"a":null,"b":true,"c":"x"}');
  });

  it('ordena claves tambien dentro de objetos anidados en arrays', () => {
    expect(serializeCanonical([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
  });
});

describe('canonicalize', () => {
  it('devuelve una estructura equivalente con las claves ya ordenadas', () => {
    expect(Object.keys(canonicalize({ b: 1, a: 2 }) as Record<string, unknown>)).toEqual([
      'a',
      'b',
    ]);
  });

  it('rechaza NaN e Infinity en vez de convertirlos en null en silencio', () => {
    expect(() => canonicalize({ x: Number.NaN })).toThrow(NonSerializableValueError);
    expect(() => canonicalize({ x: Number.POSITIVE_INFINITY })).toThrow(NonSerializableValueError);
  });

  it('el error dice donde esta el valor culpable', () => {
    expect(() => canonicalize({ metrics: { profitFactor: Number.NaN } })).toThrow(
      /metrics\.profitFactor/,
    );
    expect(() => canonicalize([{ pnlR: Number.NaN }])).toThrow(/\[0\]\.pnlR/);
  });

  it('rechaza los tipos que JSON no representa', () => {
    expect(() => canonicalize({ fn: () => 1 })).toThrow(NonSerializableValueError);
    expect(() => canonicalize({ big: 1n })).toThrow(NonSerializableValueError);
  });
});

describe('hashResult', () => {
  it('es estable entre llamadas', () => {
    expect(hashResult(makeResult())).toBe(hashResult(makeResult()));
  });

  it('no depende del orden en que se construyo el objeto', () => {
    const ordered = makeResult();
    const shuffled: BacktestResult = {
      rejectedSignals: ordered.rejectedSignals,
      equityCurve: ordered.equityCurve,
      trades: ordered.trades,
      metrics: ordered.metrics,
      engineVersion: ordered.engineVersion,
    };
    expect(hashResult(shuffled)).toBe(hashResult(ordered));
  });

  it('cambia si cambia cualquier metrica', () => {
    const base = makeResult();
    const moved = makeResult({ metrics: { ...base.metrics, netProfit: 1843.22 } });
    expect(hashResult(moved)).not.toBe(hashResult(base));
  });

  it('ignora una diferencia por debajo de la resolucion de round10', () => {
    const base = makeResult();
    const jitter = makeResult({
      metrics: { ...base.metrics, netProfit: 1843.21 + 1e-12 },
    });
    expect(hashResult(jitter)).toBe(hashResult(base));
  });

  it('devuelve un sha256 hexadecimal de 64 caracteres', () => {
    expect(hashResult(makeResult())).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('sha256', () => {
  it('coincide con el vector de prueba conocido de la cadena vacia', () => {
    expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('coincide con el vector de prueba conocido de "abc"', () => {
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
