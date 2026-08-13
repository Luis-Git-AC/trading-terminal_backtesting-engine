import { describe, expect, it } from 'vitest';
import { alignTs, candleSchema, isAligned, timeframeToMs } from '@tt/shared';
import { makeSyntheticCandles } from './synthetic-candles.js';

const FROM = Date.parse('2026-01-01T00:00:00.000Z');

describe('makeSyntheticCandles', () => {
  it('genera exactamente el numero de velas pedido', () => {
    const candles = makeSyntheticCandles({
      symbol: 'BTCUSDT',
      timeframe: '1h',
      bars: 50,
      seed: 1,
      from: FROM,
    });

    expect(candles).toHaveLength(50);
  });

  it('con 0 barras devuelve una lista vacia', () => {
    expect(
      makeSyntheticCandles({ symbol: 'BTCUSDT', timeframe: '1h', bars: 0, seed: 1, from: FROM }),
    ).toEqual([]);
  });

  it('cada vela cumple el esquema del contrato (OHLC coherente, sin negativos)', () => {
    const candles = makeSyntheticCandles({
      symbol: 'ETHUSDT',
      timeframe: '1m',
      bars: 500,
      seed: 42,
      from: FROM,
    });

    for (const candle of candles) {
      const result = candleSchema.safeParse(candle);
      expect(result.success, JSON.stringify(result.success ? null : result.error.issues)).toBe(
        true,
      );
    }
  });

  it('los timestamps estan alineados y avanzan exactamente un paso por vela', () => {
    const step = timeframeToMs('15m');
    const candles = makeSyntheticCandles({
      symbol: 'BTCUSDT',
      timeframe: '15m',
      bars: 20,
      seed: 7,
      from: FROM,
    });

    for (const candle of candles) {
      expect(isAligned(candle.t, '15m')).toBe(true);
    }
    for (let i = 1; i < candles.length; i += 1) {
      expect(candles[i]!.t - candles[i - 1]!.t).toBe(step);
    }
  });

  it('alinea un `from` desalineado en vez de fallar', () => {
    const misaligned = FROM + 90_000;
    const candles = makeSyntheticCandles({
      symbol: 'BTCUSDT',
      timeframe: '1h',
      bars: 5,
      seed: 1,
      from: misaligned,
    });

    expect(candles[0]!.t).toBe(alignTs(misaligned, '1h'));
  });

  it('es determinista: misma semilla, mismos parametros, mismo resultado', () => {
    const options = {
      symbol: 'BTCUSDT',
      timeframe: '1h' as const,
      bars: 30,
      seed: 123,
      from: FROM,
    };

    expect(makeSyntheticCandles(options)).toEqual(makeSyntheticCandles(options));
  });

  it('semillas distintas producen series distintas', () => {
    const base = { symbol: 'BTCUSDT', timeframe: '1h' as const, bars: 30, from: FROM };

    const a = makeSyntheticCandles({ ...base, seed: 1 });
    const b = makeSyntheticCandles({ ...base, seed: 2 });

    expect(a).not.toEqual(b);
  });

  it('mismo seed pero distinto simbolo o timeframe produce series distintas', () => {
    const base = { bars: 30, seed: 1, from: FROM };

    const btc = makeSyntheticCandles({ ...base, symbol: 'BTCUSDT', timeframe: '1h' });
    const eth = makeSyntheticCandles({ ...base, symbol: 'ETHUSDT', timeframe: '1h' });
    const btc15m = makeSyntheticCandles({ ...base, symbol: 'BTCUSDT', timeframe: '15m' });

    expect(btc).not.toEqual(eth);
    expect(btc.map((c) => c.o)).not.toEqual(btc15m.map((c) => c.o));
  });

  it('un trend positivo sostenido hace que el precio de cierre suba de principio a fin', () => {
    const candles = makeSyntheticCandles({
      symbol: 'BTCUSDT',
      timeframe: '1h',
      bars: 200,
      seed: 5,
      from: FROM,
      trendPerBar: 0.01,
      volPerBar: 0.0005,
    });

    expect(candles.at(-1)!.c).toBeGreaterThan(candles[0]!.o);
  });
});
