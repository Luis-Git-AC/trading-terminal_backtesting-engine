import { isAligned, timeframeToMs, type Candle, type Timeframe } from '@tt/shared';
import {
  MAX_CANDLES_LIMIT,
  type CandlesRepository,
} from '../db/repositories/candles.repo.js';

export const DEFAULT_CHUNK_BARS = 50_000;

export class UnalignedCandleError extends Error {
  override readonly name = 'UnalignedCandleError';
  readonly ts: number;
  readonly timeframe: Timeframe;

  constructor(ts: number, timeframe: Timeframe) {
    super(`La vela ${ts} no esta alineada al timeframe ${timeframe}.`);
    this.ts = ts;
    this.timeframe = timeframe;
  }
}

export class UnorderedCandleError extends Error {
  override readonly name = 'UnorderedCandleError';
  readonly ts: number;
  readonly previousTs: number;

  constructor(ts: number, previousTs: number) {
    super(`La vela ${ts} no avanza respecto a la anterior (${previousTs}).`);
    this.ts = ts;
    this.previousTs = previousTs;
  }
}

export interface LoadCandlesOptions {
  readonly candles: CandlesRepository;
  readonly exchange?: string | undefined;
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly from: number;
  readonly to: number;
  readonly chunkBars?: number | undefined;
  readonly onChunk?: ((loaded: number) => void | Promise<void>) | undefined;
}

export function chunkSize(chunkBars: number | undefined): number {
  const requested = chunkBars ?? DEFAULT_CHUNK_BARS;
  return Math.min(MAX_CANDLES_LIMIT, Math.max(1, Math.floor(requested)));
}

export async function loadCandles(options: LoadCandlesOptions): Promise<Candle[]> {
  const step = timeframeToMs(options.timeframe);
  const limit = chunkSize(options.chunkBars);
  const loaded: Candle[] = [];

  let cursor = options.from;
  let previousTs: number | null = null;

  while (cursor < options.to) {
    const page = await options.candles.getCandles({
      ...(options.exchange === undefined ? {} : { exchange: options.exchange }),
      symbol: options.symbol,
      timeframe: options.timeframe,
      from: cursor,
      to: options.to,
      limit,
    });

    if (page.length === 0) {
      break;
    }

    for (const candle of page) {
      if (!isAligned(candle.t, options.timeframe)) {
        throw new UnalignedCandleError(candle.t, options.timeframe);
      }
      if (previousTs !== null && candle.t <= previousTs) {
        throw new UnorderedCandleError(candle.t, previousTs);
      }
      previousTs = candle.t;
      loaded.push(candle);
    }

    await options.onChunk?.(loaded.length);

    if (page.length < limit) {
      break;
    }

    cursor = (previousTs ?? cursor) + step;
  }

  return loaded;
}
