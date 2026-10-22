import { z } from 'zod';
import type { Timeframe } from '@tt/shared';

export const HYPERLIQUID_DEFAULT_BASE_URL = 'https://api.hyperliquid.xyz';
export const HYPERLIQUID_INFO_PATH = '/info';

/** Hyperliquid solo guarda 5000 velas por serie: mas atras no existe nada que pedir. */
export const HYPERLIQUID_MAX_HISTORY_CANDLES = 5000;
export const HYPERLIQUID_MAX_PAGE_LIMIT = 5000;

const INTERVAL_BY_TIMEFRAME = {
  '1m': '1m',
  '15m': '15m',
  '1h': '1h',
} as const satisfies Record<Timeframe, string>;

export type HyperliquidInterval = (typeof INTERVAL_BY_TIMEFRAME)[Timeframe];

export function toInterval(timeframe: Timeframe): HyperliquidInterval {
  return INTERVAL_BY_TIMEFRAME[timeframe];
}

export function fromInterval(interval: string): Timeframe | undefined {
  for (const [timeframe, value] of Object.entries(INTERVAL_BY_TIMEFRAME)) {
    if (value === interval) return timeframe as Timeframe;
  }
  return undefined;
}

/** La vela llega como objeto, no como array. */
export const hyperliquidCandleSchema = z.object({
  t: z.number(),
  T: z.number(),
  o: z.string(),
  h: z.string(),
  l: z.string(),
  c: z.string(),
  v: z.string(),
});

export type HyperliquidCandle = z.infer<typeof hyperliquidCandleSchema>;

export function candleSnapshotBody(
  coin: string,
  timeframe: Timeframe,
  startTime: number,
  endTime: number,
): string {
  return JSON.stringify({
    type: 'candleSnapshot',
    req: { coin, interval: toInterval(timeframe), startTime, endTime },
  });
}
