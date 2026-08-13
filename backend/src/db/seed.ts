import { timeframeToMs, type Timeframe } from '@tt/shared';
import type { CandlesRepository } from './repositories/candles.repo.js';
import { makeSyntheticCandles } from './synthetic-candles.js';

export const DEFAULT_SEED_BARS = 2000;

export interface SeedSeriesOptions {
  readonly candles: CandlesRepository;
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly from: number;
  readonly bars: number;
  readonly seed: number;
  readonly closedBoundary: number;
}

export interface SeedReport {
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly seed: number;
  readonly requestedBars: number;
  readonly generated: number;
  readonly written: number;
  readonly fromTs: number;
  readonly toTs: number;
}

function effectiveBars(options: SeedSeriesOptions, step: number): number {
  const requestedLastTs = options.from + (options.bars - 1) * step;
  const lastTs = Math.min(requestedLastTs, options.closedBoundary);

  if (lastTs < options.from) {
    return 0;
  }

  return Math.round((lastTs - options.from) / step) + 1;
}

export async function seedSeries(options: SeedSeriesOptions): Promise<SeedReport> {
  const step = timeframeToMs(options.timeframe);
  const bars = effectiveBars(options, step);

  const candles = makeSyntheticCandles({
    symbol: options.symbol,
    timeframe: options.timeframe,
    bars,
    seed: options.seed,
    from: options.from,
  });

  const written =
    candles.length === 0
      ? 0
      : await options.candles.upsertCandles({
          symbol: options.symbol,
          timeframe: options.timeframe,
          source: 'synthetic',
          candles,
        });

  return {
    symbol: options.symbol,
    timeframe: options.timeframe,
    seed: options.seed,
    requestedBars: options.bars,
    generated: candles.length,
    written,
    fromTs: options.from,
    toTs: options.from + candles.length * step,
  };
}
