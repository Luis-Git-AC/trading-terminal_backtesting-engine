import type { Indicator } from '../types.js';
import { assertPeriod } from './period.js';

export function createSma(period: number): Indicator<number> {
  assertPeriod('SMA', period);

  const window = new Array<number>(period).fill(0);
  let cursor = 0;
  let seen = 0;
  let sum = 0;
  let value: number | null = null;

  return {
    update(input: number): number | null {
      if (seen >= period) {
        sum -= window[cursor] ?? 0;
      }
      window[cursor] = input;
      cursor = (cursor + 1) % period;
      sum += input;
      seen += 1;
      value = seen >= period ? sum / period : null;
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
