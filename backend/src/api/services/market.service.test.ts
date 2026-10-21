import { describe, expect, it } from 'vitest';
import type { Timeframe } from '@tt/shared';
import {
  DEFAULT_PRICE_PRECISION,
  DEFAULT_QTY_PRECISION,
  SYMBOL_PRECISION,
  listMarkets,
  type MarketServiceDeps,
} from './market.service.js';

const TIMEFRAMES: readonly Timeframe[] = ['1m', '15m', '1h'];

function deps(
  symbols: readonly string[],
  precision?: MarketServiceDeps['precision'],
): MarketServiceDeps {
  return {
    exchange: 'bitget',
    symbols,
    timeframes: TIMEFRAMES,
    now: () => 0,
    ...(precision === undefined ? {} : { precision }),
  } as unknown as MarketServiceDeps;
}

function priceOf(symbol: string): number {
  const response = listMarkets(deps([symbol]));
  return response.symbols[0]?.pricePrecision ?? Number.NaN;
}

describe('listMarkets', () => {
  it('sirve los tres pares del MVP con sus timeframes', () => {
    const response = listMarkets(deps(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']));
    expect(response.symbols.map((market) => market.symbol)).toEqual([
      'BTCUSDT',
      'ETHUSDT',
      'SOLUSDT',
    ]);
    expect(response.symbols[0]?.timeframes).toEqual(TIMEFRAMES);
  });

  it('da mas decimales de precio a los pares mas baratos', () => {
    expect(priceOf('ETHUSDT')).toBeGreaterThan(priceOf('BTCUSDT'));
    expect(priceOf('SOLUSDT')).toBeGreaterThan(priceOf('ETHUSDT'));
  });

  it('aplica la precision declarada para cada par conocido', () => {
    const response = listMarkets(deps(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']));
    for (const market of response.symbols) {
      const expected = SYMBOL_PRECISION[market.symbol];
      expect(expected).toBeDefined();
      expect(market.pricePrecision).toBe(expected?.price);
      expect(market.qtyPrecision).toBe(expected?.qty);
    }
  });

  it('un par no declarado cae a la precision por defecto', () => {
    const response = listMarkets(deps(['DOGEUSDT']));
    expect(response.symbols[0]?.pricePrecision).toBe(DEFAULT_PRICE_PRECISION);
    expect(response.symbols[0]?.qtyPrecision).toBe(DEFAULT_QTY_PRECISION);
  });

  it('una precision inyectada explicitamente gana sobre el mapa', () => {
    const response = listMarkets(deps(['SOLUSDT'], { SOLUSDT: { price: 9, qty: 9 } }));
    expect(response.symbols[0]?.pricePrecision).toBe(9);
    expect(response.symbols[0]?.qtyPrecision).toBe(9);
  });
});
