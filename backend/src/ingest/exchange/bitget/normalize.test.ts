import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeCandles } from './normalize.js';

function loadFixture(name: string): { data: unknown } {
  const url = new URL(`../../../__fixtures__/bitget/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as { data: unknown };
}

function rowsOf(name: string): unknown[] {
  const { data } = loadFixture(name);
  if (!Array.isArray(data)) throw new Error(`El fixture ${name} no tiene un data de tipo array`);
  return data;
}

describe('normalizeCandles sobre el payload real de Bitget', () => {
  it('convierte los strings a numeros conservando los valores del fixture', () => {
    const { candles, discarded } = normalizeCandles(rowsOf('history-candles-15m-ok'), '15m');

    expect(discarded).toEqual([]);
    expect(candles).toEqual([
      { t: 1767225600000, o: 87624.4, h: 87796.4, l: 87607, c: 87720.2, v: 292.2548 },
      { t: 1767226500000, o: 87720.2, h: 87769.8, l: 87720.2, c: 87760.8, v: 60.0385 },
      { t: 1767227400000, o: 87760.8, h: 87761.5, l: 87707.6, c: 87730.5, v: 59.1333 },
      { t: 1767228300000, o: 87730.5, h: 87834.6, l: 87730.5, c: 87790, v: 70.5034 },
      { t: 1767229200000, o: 87790, h: 88003.4, l: 87790, c: 87981.1, v: 349.0742 },
    ]);
  });

  it('usa el volumen en moneda base, no el de cotizacion', () => {
    const [first] = normalizeCandles(rowsOf('history-candles-15m-ok'), '15m').candles;

    expect(first?.v).toBe(292.2548);
    expect(first?.v).not.toBe(25640341.80199);
  });

  it('un data vacio no es un error: devuelve cero velas y cero descartes', () => {
    expect(normalizeCandles(rowsOf('history-candles-empty'), '15m')).toEqual({
      candles: [],
      discarded: [],
    });
  });

  it('devuelve las velas en orden ascendente aunque lleguen desordenadas', () => {
    const shuffled = [...rowsOf('history-candles-15m-ok')].reverse();

    const timestamps = normalizeCandles(shuffled, '15m').candles.map((candle) => candle.t);

    expect(timestamps).toEqual([
      1767225600000, 1767226500000, 1767227400000, 1767228300000, 1767229200000,
    ]);
  });
});

describe('normalizeCandles: descarte de filas invalidas', () => {
  it('descarta cada fila mala por su motivo y conserva las buenas', () => {
    const { candles, discarded } = normalizeCandles(rowsOf('history-candles-15m-dirty'), '15m');

    expect(candles.map((candle) => candle.t)).toEqual([1767225600000, 1767231000000]);
    expect(discarded.map(({ index, reason }) => ({ index, reason }))).toEqual([
      { index: 1, reason: 'malformed' },
      { index: 2, reason: 'invalid-candle' },
      { index: 3, reason: 'unaligned' },
      { index: 4, reason: 'not-numeric' },
      { index: 5, reason: 'invalid-candle' },
    ]);
  });

  it('explica el motivo con datos concretos, no con un mensaje generico', () => {
    const { discarded } = normalizeCandles(rowsOf('history-candles-15m-dirty'), '15m');

    expect(discarded[2]?.detail).toContain('1767228330000');
    expect(discarded[2]?.detail).toContain('15m');
    expect(discarded[3]?.detail).toContain('el campo h');
    expect(discarded[1]?.detail).toContain('high');
  });

  it('rechaza un ts que no es un epoch en ms entero y no negativo', () => {
    const rows = [
      ['-900000', '1', '2', '0.5', '1.5', '10'],
      ['1767225600000.5', '1', '2', '0.5', '1.5', '10'],
      ['99999999999999999999', '1', '2', '0.5', '1.5', '10'],
    ];

    const { candles, discarded } = normalizeCandles(rows, '15m');

    expect(candles).toEqual([]);
    expect(discarded.map((row) => row.reason)).toEqual(['invalid-ts', 'invalid-ts', 'invalid-ts']);
  });

  it('descarta lo que no es una fila de velas sin tirar el proceso', () => {
    const { candles, discarded } = normalizeCandles([null, 'texto', {}, [], 42], '1h');

    expect(candles).toEqual([]);
    expect(discarded.map((row) => row.reason)).toEqual(Array<string>(5).fill('malformed'));
  });

  it('acepta filas con campos de sobra: solo lee los seis primeros', () => {
    const rows = [['1767225600000', '1', '2', '0.5', '1.5', '10', '999', 'extra']];

    expect(normalizeCandles(rows, '15m').candles).toEqual([
      { t: 1767225600000, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 },
    ]);
  });

  it('aplica la alineacion del timeframe pedido, no la del payload', () => {
    const rows = [['1767225900000', '1', '2', '0.5', '1.5', '10']];

    expect(normalizeCandles(rows, '1m').candles).toHaveLength(1);
    expect(normalizeCandles(rows, '15m').discarded[0]?.reason).toBe('unaligned');
  });
});
