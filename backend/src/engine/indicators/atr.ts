import type { Candle } from '@tt/shared';
import type { Indicator } from '../types.js';
import { assertPeriod } from './period.js';

export function trueRange(bar: Candle, previousClose: number | null): number {
  if (previousClose === null) {
    return bar.h - bar.l;
  }
  return Math.max(
    bar.h - bar.l,
    Math.abs(bar.h - previousClose),
    Math.abs(bar.l - previousClose),
  );
}

export function createAtr(period: number): Indicator<Candle> {
  assertPeriod('ATR', period);

  let previousClose: number | null = null;
  let seen = 0;
  let seedSum = 0;
  let value: number | null = null;

  return {
    update(bar: Candle): number | null {
      const range = trueRange(bar, previousClose);
      previousClose = bar.c;
      seen += 1;
      if (value === null) {
        seedSum += range;
        if (seen >= period) {
          value = seedSum / period;
        }
        return value;
      }
      value = (value * (period - 1) + range) / period;
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
