import { z } from 'zod';

export const EXCHANGES = ['binance', 'hyperliquid', 'bitget'] as const;

export type Exchange = (typeof EXCHANGES)[number];

export const DEFAULT_EXCHANGE: Exchange = 'bitget';

export function isExchange(value: unknown): value is Exchange {
  return typeof value === 'string' && EXCHANGES.some((id) => id === value);
}

export const exchangeSchema = z.enum(EXCHANGES);
