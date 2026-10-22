import type { ExchangeAdapter } from '../adapter.js';
import { createBitgetRestClient } from './rest.js';
import { BITGET_MAX_PAGE_LIMIT } from './types.js';
import { createBitgetCandleStream } from './ws.js';

export function createBitgetAdapter(): ExchangeAdapter {
  return {
    id: 'bitget',
    maxHistoryCandles: null,
    maxPageLimit: BITGET_MAX_PAGE_LIMIT,
    createRestClient: (options = {}) => createBitgetRestClient(options),
    createCandleStream: (options = {}) => createBitgetCandleStream(options),
    normalizeSymbol: (raw) => raw.trim().toUpperCase(),
  };
}
