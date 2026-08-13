import { alignTs, timeframeToMs, type Candle, type Timeframe } from '@tt/shared';
import { round10 } from '../engine/num.js';
import { mulberry32 } from '../engine/prng.js';

export const DEFAULT_START_PRICE = 100;
export const DEFAULT_TREND_PER_BAR = 0;
export const DEFAULT_VOL_PER_BAR = 0.006;
export const DEFAULT_BASE_VOLUME = 25;

const MAX_RETURN_PER_BAR = 0.2;
const WICK_FACTOR = 1.5;

export interface SyntheticSeriesOptions {
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly bars: number;
  readonly seed: number;
  readonly from: number;
  readonly startPrice?: number;
  readonly trendPerBar?: number;
  readonly volPerBar?: number;
  readonly baseVolume?: number;
}

function deriveSeed(seed: number, key: string): number {
  let hash = (seed >>> 0) ^ 0x9e3779b9;
  for (let i = 0; i < key.length; i += 1) {
    hash = Math.imul(hash ^ key.charCodeAt(i), 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function makeSyntheticCandles(options: SyntheticSeriesOptions): Candle[] {
  if (options.bars <= 0) {
    return [];
  }

  const startPrice = options.startPrice ?? DEFAULT_START_PRICE;
  const trendPerBar = options.trendPerBar ?? DEFAULT_TREND_PER_BAR;
  const volPerBar = options.volPerBar ?? DEFAULT_VOL_PER_BAR;
  const baseVolume = options.baseVolume ?? DEFAULT_BASE_VOLUME;

  const step = timeframeToMs(options.timeframe);
  const from = alignTs(options.from, options.timeframe);
  const rng = mulberry32(deriveSeed(options.seed, `${options.symbol}:${options.timeframe}`));

  const candles: Candle[] = [];
  let price = startPrice;

  for (let i = 0; i < options.bars; i += 1) {
    const open = price;
    const rawReturn = trendPerBar + volPerBar * (rng() * 2 - 1);
    const clampedReturn = Math.max(-MAX_RETURN_PER_BAR, Math.min(MAX_RETURN_PER_BAR, rawReturn));
    const close = open * (1 + clampedReturn);

    const o = round10(open);
    const c = round10(close);
    const wickUp = rng() * volPerBar * WICK_FACTOR;
    const wickDown = rng() * volPerBar * WICK_FACTOR;
    const h = round10(Math.max(o, c, Math.max(o, c) * (1 + wickUp)));
    const l = round10(Math.min(o, c, Math.min(o, c) * (1 - wickDown)));
    const v = round10(baseVolume * (0.5 + rng()));

    candles.push({ t: from + i * step, o, h, l, c, v });

    price = close;
  }

  return candles;
}
