import { z } from 'zod';
import type { Timeframe } from '@tt/shared';

export const BINANCE_DEFAULT_BASE_URL = 'https://fapi.binance.com';
export const BINANCE_KLINES_PATH = '/fapi/v1/klines';
export const BINANCE_MAX_PAGE_LIMIT = 1500;

// Peso de /fapi/v1/klines con limit > 1000 y tope por minuto de la IP (docs de Binance).
export const BINANCE_WEIGHT_PER_MINUTE = 2400;

const INTERVAL_BY_TIMEFRAME = {
  '1m': '1m',
  '15m': '15m',
  '1h': '1h',
} as const satisfies Record<Timeframe, string>;

export type BinanceInterval = (typeof INTERVAL_BY_TIMEFRAME)[Timeframe];

export function toInterval(timeframe: Timeframe): BinanceInterval {
  return INTERVAL_BY_TIMEFRAME[timeframe];
}

export const binanceErrorSchema = z.object({ code: z.number(), msg: z.string() });

// [openTime, open, high, low, close, volume, closeTime, quoteVolume, ...]
export const binanceKlineRowSchema = z
  .tuple([
    z.number(),
    z.string(),
    z.string(),
    z.string(),
    z.string(),
    z.string(),
    z.number(),
    z.string(),
  ])
  .rest(z.unknown());

export type BinanceKlineRow = z.infer<typeof binanceKlineRowSchema>;
