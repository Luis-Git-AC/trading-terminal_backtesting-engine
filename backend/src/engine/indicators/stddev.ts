import type { Indicator } from '../types.js';
import { assertPeriod } from './period.js';

export function createStdDev(period: number): Indicator<number> {
  assertPeriod('StdDev', period);

  const window = new Array<number>(period).fill(0);
  let cursor = 0;
  let seen = 0;
  let count = 0;
  let mean = 0;
  let m2 = 0;

  const remove = (sample: number): void => {
    const nextCount = count - 1;
    if (nextCount === 0) {
      count = 0;
      mean = 0;
      m2 = 0;
      return;
    }
    const delta = sample - mean;
    mean -= delta / nextCount;
    m2 -= delta * (sample - mean);
    count = nextCount;
  };

  const add = (sample: number): void => {
    const nextCount = count + 1;
    const delta = sample - mean;
    mean += delta / nextCount;
    m2 += delta * (sample - mean);
    count = nextCount;
  };

  const current = (): number | null => {
    if (seen < period) {
      return null;
    }
    return Math.sqrt(Math.max(0, m2) / count);
  };

  return {
    update(input: number): number | null {
      if (seen >= period) {
        remove(window[cursor] ?? 0);
      }
      window[cursor] = input;
      cursor = (cursor + 1) % period;
      add(input);
      seen += 1;
      return current();
    },
    get(): number | null {
      return current();
    },
    get ready(): boolean {
      return seen >= period;
    },
  };
}
