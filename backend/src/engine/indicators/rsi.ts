import type { Indicator } from '../types.js';
import { assertPeriod } from './period.js';

function resolve(avgGain: number, avgLoss: number): number {
  if (avgGain === 0 && avgLoss === 0) {
    return 50;
  }
  if (avgLoss === 0) {
    return 100;
  }
  return 100 - 100 / (1 + avgGain / avgLoss);
}

export function createRsi(period: number): Indicator<number> {
  assertPeriod('RSI', period);

  let previous: number | null = null;
  let deltas = 0;
  let seedGain = 0;
  let seedLoss = 0;
  let avgGain: number | null = null;
  let avgLoss: number | null = null;
  let value: number | null = null;

  return {
    update(input: number): number | null {
      if (previous === null) {
        previous = input;
        return null;
      }

      const delta = input - previous;
      previous = input;
      const gain = Math.max(0, delta);
      const loss = Math.max(0, -delta);
      deltas += 1;

      if (avgGain === null || avgLoss === null) {
        seedGain += gain;
        seedLoss += loss;
        if (deltas >= period) {
          avgGain = seedGain / period;
          avgLoss = seedLoss / period;
          value = resolve(avgGain, avgLoss);
        }
        return value;
      }

      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      value = resolve(avgGain, avgLoss);
      return value;
    },
    get(): number | null {
      return value;
    },
    get ready(): boolean {
      return deltas >= period;
    },
  };
}
