import type { Indicator } from '../types.js';
import { assertPeriod } from './period.js';

export function createEma(period: number): Indicator<number> {
  assertPeriod('EMA', period);

  const smoothing = 2 / (period + 1);
  let seen = 0;
  let seedSum = 0;
  let value: number | null = null;

  return {
    update(input: number): number | null {
      seen += 1;
      if (value === null) {
        seedSum += input;
        if (seen >= period) {
          value = seedSum / period;
        }
        return value;
      }
      value = value + smoothing * (input - value);
      return value;
    },
    get(): number | null {
      return value;
    },
    get ready(): boolean {
      return seen >= period;
    },
  };
}
