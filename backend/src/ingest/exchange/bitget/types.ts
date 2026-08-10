import { z } from 'zod';
import type { Timeframe } from '@tt/shared';

export const BITGET_DEFAULT_BASE_URL = 'https://api.bitget.com';
export const BITGET_HISTORY_CANDLES_PATH = '/api/v2/mix/market/history-candles';
export const BITGET_PRODUCT_TYPE = 'USDT-FUTURES';
export const BITGET_OK_CODE = '00000';
export const BITGET_MAX_PAGE_LIMIT = 200;

const GRANULARITY_BY_TIMEFRAME = {
  '1m': '1m',
  '15m': '15m',
  '1h': '1H',
} as const satisfies Record<Timeframe, string>;

export type BitgetGranularity = (typeof GRANULARITY_BY_TIMEFRAME)[Timeframe];

export function toGranularity(timeframe: Timeframe): BitgetGranularity {
  return GRANULARITY_BY_TIMEFRAME[timeframe];
}

export const bitgetEnvelopeSchema = z.object({
  code: z.string(),
  msg: z.string(),
  data: z.unknown(),
});

export type BitgetEnvelope = z.infer<typeof bitgetEnvelopeSchema>;

export const bitgetCandleRowSchema = z
  .tuple([z.string(), z.string(), z.string(), z.string(), z.string(), z.string()])
  .rest(z.string());

export type BitgetCandleRow = z.infer<typeof bitgetCandleRowSchema>;
