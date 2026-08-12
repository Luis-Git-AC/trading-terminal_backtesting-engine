import type { Candle } from '@tt/shared';
import { emaCross, type EmaCrossParams, type EmaCrossState } from '../../strategies/ema-cross.js';
import { mulberry32 } from '../prng.js';
import { runBacktest } from '../run-backtest.js';
import type { BacktestInput, ExecConfig } from '../types.js';

const BARS = 100_000;
const BUDGET_MS = 10_000;

const EXEC: ExecConfig = {
  initialCapital: 10_000,
  riskPerTradePct: 1,
  feeBps: 6,
  slippageBps: 2,
  fillModel: 'next-open',
};

function syntheticCandles(count: number, seed: number): Candle[] {
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

function main(): void {
  const candles = syntheticCandles(BARS, 20_260_812);
  const input: BacktestInput<EmaCrossParams, EmaCrossState> = {
    candles,
    strategy: emaCross,
    params: { fastPeriod: 12, slowPeriod: 26, atrPeriod: 14, atrStopMult: 2, takeProfitR: 2 },
    exec: EXEC,
    seed: 42,
  };

  const startedAt = performance.now();
  const result = runBacktest(input);
  const elapsedMs = performance.now() - startedAt;
  const barsPerSecond = Math.round((BARS / elapsedMs) * 1000);

  console.log(
    JSON.stringify(
      {
        bars: BARS,
        elapsedMs: Math.round(elapsedMs),
        barsPerSecond,
        trades: result.trades.length,
        rejectedSignals: result.rejectedSignals,
        budgetMs: BUDGET_MS,
        withinBudget: elapsedMs <= BUDGET_MS,
        node: process.version,
      },
      null,
      2,
    ),
  );

  if (elapsedMs > BUDGET_MS) {
    console.error(`El motor tardo ${Math.round(elapsedMs)} ms, por encima de ${BUDGET_MS} ms.`);
    process.exitCode = 1;
  }
}

main();
