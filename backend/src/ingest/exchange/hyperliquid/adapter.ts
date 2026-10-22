import type { ExchangeAdapter } from '../adapter.js';
import { createHyperliquidRestClient } from './rest.js';
import { HYPERLIQUID_MAX_HISTORY_CANDLES, HYPERLIQUID_MAX_PAGE_LIMIT } from './types.js';
import { createHyperliquidCandleStream } from './ws.js';

export function createHyperliquidAdapter(): ExchangeAdapter {
  return {
    id: 'hyperliquid',
    maxHistoryCandles: HYPERLIQUID_MAX_HISTORY_CANDLES,
    maxPageLimit: HYPERLIQUID_MAX_PAGE_LIMIT,
    createRestClient: (options = {}) => createHyperliquidRestClient(options),
    createCandleStream: (options = {}) => createHyperliquidCandleStream(options),
    normalizeSymbol: (raw) => raw.trim().toUpperCase(),
  };
}
