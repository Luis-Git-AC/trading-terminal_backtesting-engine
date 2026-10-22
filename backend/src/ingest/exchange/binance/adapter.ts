import type { ExchangeAdapter } from '../adapter.js';
import { createBinanceRestClient } from './rest.js';
import { BINANCE_MAX_PAGE_LIMIT } from './types.js';

export function createBinanceAdapter(): ExchangeAdapter {
  return {
    id: 'binance',
    maxHistoryCandles: null,
    maxPageLimit: BINANCE_MAX_PAGE_LIMIT,
    createRestClient: (options = {}) => createBinanceRestClient(options),
    createCandleStream: () => {
      throw new Error('El stream de velas de Binance llega en F7b-T2');
    },
    normalizeSymbol: (raw) => raw.trim().toUpperCase(),
  };
}
