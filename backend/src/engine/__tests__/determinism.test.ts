import type { Candle } from '@tt/shared';
import { describe, expect, it } from 'vitest';
import {
  emaCross,
  emaCrossParamsSchema,
  type EmaCrossParams,
  type EmaCrossState,
} from '../../strategies/ema-cross.js';
import {
  rangeBreakout,
  type RangeBreakoutParams,
  type RangeBreakoutState,
} from '../../strategies/range-breakout.js';
import { mulberry32 } from '../prng.js';
import { runBacktest } from '../run-backtest.js';
import { hashResult } from '../serialize.js';
import type { BacktestInput, ExecConfig } from '../types.js';

const EXEC: ExecConfig = {
  initialCapital: 10_000,
  riskPerTradePct: 1,
  feeBps: 6,
  slippageBps: 2,
  fillModel: 'next-open',
};

export function syntheticCandles(count: number, seed: number): Candle[] {
  const random = mulberry32(seed);
  const candles: Candle[] = [];
  let price = 100;
  for (let i = 0; i < count; i += 1) {
    price = Math.max(1, price * (1 + (random() - 0.5) * 0.02));
    const high = price * (1 + random() * 0.005);
    const low = price * (1 - random() * 0.005);
    candles.push({
      t: 1_700_000_000_000 + i * 60_000,
      o: price,
      h: Math.max(high, price),
      l: Math.min(low, price),
      c: price,
      v: 1 + random(),
    });
  }
  return candles;
}

function inputFor(
  candles: readonly Candle[],
  seed: number,
): BacktestInput<EmaCrossParams, EmaCrossState> {
  return {
    candles,
    strategy: emaCross,
    params: { fastPeriod: 5, slowPeriod: 12, atrPeriod: 7, atrStopMult: 2, takeProfitR: 2 },
    exec: EXEC,
    seed,
  };
}

describe('determinismo del motor', () => {
  it('mismo input y misma semilla dan el mismo hash, para 20 semillas', () => {
    const candles = syntheticCandles(600, 4_242);
    for (let seed = 1; seed <= 20; seed += 1) {
      const first = runBacktest(inputFor(candles, seed));
      const second = runBacktest(inputFor(candles, seed));
      expect(hashResult(second)).toBe(hashResult(first));
    }
  });

  it('el resultado es identico con y sin onProgress', () => {
    const candles = syntheticCandles(1_200, 77);
    const plain = runBacktest(inputFor(candles, 9));
    let calls = 0;
    const observed = runBacktest({
      ...inputFor(candles, 9),
      onProgress: () => {
        calls += 1;
      },
      progressEveryBars: 100,
    });
    expect(calls).toBeGreaterThan(0);
    expect(hashResult(observed)).toBe(hashResult(plain));
  });

  it('da igual como se haya construido el array de velas', () => {
    const source = syntheticCandles(500, 31);
    const byChunks: Candle[] = [];
    for (let start = 0; start < source.length; start += 37) {
      for (const candle of source.slice(start, start + 37)) {
        byChunks.push({ ...candle });
      }
    }
    expect(hashResult(runBacktest(inputFor(byChunks, 5)))).toBe(
      hashResult(runBacktest(inputFor(source, 5))),
    );
  });

  it('semillas distintas no cambian el resultado si la estrategia no usa el PRNG', () => {
    const candles = syntheticCandles(400, 12);
    expect(hashResult(runBacktest(inputFor(candles, 1)))).toBe(
      hashResult(runBacktest(inputFor(candles, 2))),
    );
  });

  it('cambiar un parametro si cambia el hash', () => {
    const candles = syntheticCandles(400, 12);
    const base = runBacktest(inputFor(candles, 1));
    const tweaked = runBacktest({
      ...inputFor(candles, 1),
      params: { fastPeriod: 6, slowPeriod: 12, atrPeriod: 7, atrStopMult: 2, takeProfitR: 2 },
    });
    expect(hashResult(tweaked)).not.toBe(hashResult(base));
  });

  it('range-breakout tambien es determinista', () => {
    const candles = syntheticCandles(800, 555);
    const build = (): BacktestInput<RangeBreakoutParams, RangeBreakoutState> => ({
      candles,
      strategy: rangeBreakout,
      params: { lookback: 10, atrPeriod: 7, atrStopMult: 2, takeProfitR: 2 },
      exec: EXEC,
      seed: 3,
    });
    expect(hashResult(runBacktest(build()))).toBe(hashResult(runBacktest(build())));
  });

  it('el motor produce trades de verdad en estas series, el test no es vacuo', () => {
    const candles = syntheticCandles(600, 4_242);
    const result = runBacktest(inputFor(candles, 1));
    expect(result.trades.length).toBeGreaterThan(0);
    expect(emaCrossParamsSchema.parse({}).fastPeriod).toBe(12);
  });
});
