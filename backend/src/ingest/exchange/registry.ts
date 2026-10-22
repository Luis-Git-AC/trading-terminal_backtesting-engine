import { EXCHANGES, type Exchange } from '@tt/shared';
import { AppError } from '../../api/errors.js';
import type { ExchangeAdapter } from './adapter.js';
import { createBinanceAdapter } from './binance/adapter.js';
import { createBitgetAdapter } from './bitget/adapter.js';
import { createHyperliquidAdapter } from './hyperliquid/adapter.js';

/** Un id de `EXCHANGES` sin entrada aqui es un exchange cuyo adapter aun no existe. */
const FACTORIES: Partial<Record<Exchange, () => ExchangeAdapter>> = {
  binance: createBinanceAdapter,
  bitget: createBitgetAdapter,
  hyperliquid: createHyperliquidAdapter,
};

export const IMPLEMENTED_EXCHANGES: readonly Exchange[] = EXCHANGES.filter(
  (id) => FACTORIES[id] !== undefined,
);

export function getAdapter(id: string): ExchangeAdapter {
  const known = EXCHANGES.find((candidate) => candidate === id);
  const factory = known === undefined ? undefined : FACTORIES[known];
  if (factory === undefined) {
    throw new AppError(
      'UNKNOWN_EXCHANGE',
      `Exchange sin adapter: ${id}. Disponibles: ${IMPLEMENTED_EXCHANGES.join(', ')}`,
    );
  }
  return factory();
}
