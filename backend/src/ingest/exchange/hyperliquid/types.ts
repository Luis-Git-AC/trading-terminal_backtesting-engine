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

/** El funding de Hyperliquid se liquida cada hora. */
export const HYPERLIQUID_FUNDING_INTERVAL_HOURS = 1;

export const hyperliquidFundingRowSchema = z.object({
  coin: z.string(),
  fundingRate: z.string(),
  time: z.number(),
});

/** El `ctx` de un activo: lo mismo que manda el WS en `activeAssetCtx` y el REST en `metaAndAssetCtxs`. */
export const hyperliquidAssetCtxSchema = z.object({
  funding: z.string(),
  openInterest: z.string(),
  markPx: z.string().optional(),
  oraclePx: z.string().optional(),
});

export type HyperliquidAssetCtx = z.infer<typeof hyperliquidAssetCtxSchema>;

export function fundingHistoryBody(coin: string, startTime: number, endTime?: number): string {
  return JSON.stringify({
    type: 'fundingHistory',
    coin,
    startTime,
    ...(endTime === undefined ? {} : { endTime }),
  });
}

export function metaAndAssetCtxsBody(dex?: string): string {
  return JSON.stringify({ type: 'metaAndAssetCtxs', ...(dex === undefined ? {} : { dex }) });
}

/** Los mercados HIP-3 llevan prefijo de dex en minusculas: `xyz:GOLD`. */
export function dexOf(coin: string): string | undefined {
  const colon = coin.indexOf(':');
  return colon === -1 ? undefined : coin.slice(0, colon);
}
