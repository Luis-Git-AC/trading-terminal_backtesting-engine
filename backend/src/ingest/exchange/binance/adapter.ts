import type { ExchangeAdapter } from '../adapter.js';
import { createBinanceDerivativesClient } from './derivatives.js';
import { createBinanceRestClient } from './rest.js';
import { BINANCE_MAX_PAGE_LIMIT } from './types.js';
import { createBinanceCandleStream } from './ws.js';

export function createBinanceAdapter(): ExchangeAdapter {
  return {
    id: 'binance',
    maxHistoryCandles: null,
    maxPageLimit: BINANCE_MAX_PAGE_LIMIT,
    createRestClient: (options = {}) => createBinanceRestClient(options),
    createCandleStream: (options = {}) => createBinanceCandleStream(options),
    createDerivativesClient: (options = {}) => createBinanceDerivativesClient(options),
    normalizeSymbol: (raw) => raw.trim().toUpperCase(),
  };
}
