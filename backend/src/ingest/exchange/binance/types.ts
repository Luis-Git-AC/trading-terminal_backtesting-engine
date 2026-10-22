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

export const BINANCE_FUNDING_PATH = '/fapi/v1/fundingRate';
export const BINANCE_FUNDING_INFO_PATH = '/fapi/v1/fundingInfo';
export const BINANCE_OI_HIST_PATH = '/futures/data/openInterestHist';
export const BINANCE_OI_PATH = '/fapi/v1/openInterest';

/** Tope de `/fapi/v1/fundingRate` (docs de Binance). */
export const BINANCE_FUNDING_MAX_LIMIT = 1000;
/** Tope de `futures/data/openInterestHist`, que ademas solo guarda 30 dias. */
export const BINANCE_OI_HIST_MAX_LIMIT = 500;
export const BINANCE_OI_HIST_WINDOW_DAYS = 30;
/** Periodo por defecto del funding cuando `fundingInfo` no lista el simbolo. */
export const BINANCE_DEFAULT_FUNDING_INTERVAL_HOURS = 8;

export const binanceFundingRowSchema = z.object({
  symbol: z.string(),
  fundingTime: z.number(),
  fundingRate: z.string(),
});

export const binanceFundingInfoRowSchema = z.object({
  symbol: z.string(),
  fundingIntervalHours: z.number().int().positive(),
});

export const binanceOpenInterestHistRowSchema = z.object({
  symbol: z.string(),
  sumOpenInterest: z.string(),
  sumOpenInterestValue: z.string(),
  timestamp: z.number(),
});

export const binanceOpenInterestSchema = z.object({
  symbol: z.string(),
  openInterest: z.string(),
  time: z.number(),
});

export const OI_HIST_PERIODS = ['5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d'] as const;

export type OpenInterestPeriod = (typeof OI_HIST_PERIODS)[number];
