import { EXCHANGES, type Exchange } from '@tt/shared';
import { AppError } from '../../api/errors.js';
import type { ExchangeAdapter } from './adapter.js';
import { createBitgetAdapter } from './bitget/adapter.js';

const FACTORIES: Record<Exchange, () => ExchangeAdapter> = {
  bitget: createBitgetAdapter,
};

export function getAdapter(id: string): ExchangeAdapter {
  const factory = EXCHANGES.find((known) => known === id);
  if (factory === undefined) {
    throw new AppError(
      'UNKNOWN_EXCHANGE',
      `Exchange desconocido: ${id}. Conocidos: ${EXCHANGES.join(', ')}`,
    );
  }
  return FACTORIES[factory]();
}
