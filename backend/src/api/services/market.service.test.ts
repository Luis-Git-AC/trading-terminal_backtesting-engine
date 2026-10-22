import { describe, expect, it } from 'vitest';
import type { Timeframe } from '@tt/shared';
import {
  DEFAULT_PRICE_PRECISION,
  DEFAULT_QTY_PRECISION,
  SYMBOL_PRECISION,
  listMarkets,
  precisionKey,
  type MarketServiceDeps,
} from './market.service.js';

const TIMEFRAMES: readonly Timeframe[] = ['1m', '15m', '1h'];

function deps(
  symbols: readonly string[],
  precision?: MarketServiceDeps['precision'],
): MarketServiceDeps {
  return {
    exchanges: [{ exchange: 'binance', symbols }],
    timeframes: TIMEFRAMES,
    now: () => 0,
    ...(precision === undefined ? {} : { precision }),
  } as unknown as MarketServiceDeps;
}

function marketsOf(response: ReturnType<typeof listMarkets>) {
  return response.exchanges[0]?.symbols ?? [];
}

function priceOf(symbol: string): number {
  return marketsOf(listMarkets(deps([symbol])))[0]?.pricePrecision ?? Number.NaN;
}

describe('listMarkets', () => {
  it('sirve los tres pares del MVP con sus timeframes', () => {
    const markets = marketsOf(listMarkets(deps(['BTCUSDT', 'ETHUSDT', 'SOLUSDT'])));
    expect(markets.map((market) => market.symbol)).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
    expect(markets[0]?.timeframes).toEqual(TIMEFRAMES);
  });

  it('da mas decimales de precio a los pares mas baratos', () => {
    expect(priceOf('ETHUSDT')).toBeGreaterThan(priceOf('BTCUSDT'));
    expect(priceOf('SOLUSDT')).toBeGreaterThan(priceOf('ETHUSDT'));
  });

  it('aplica la precision declarada para cada par conocido', () => {
    const markets = marketsOf(listMarkets(deps(['BTCUSDT', 'ETHUSDT', 'SOLUSDT'])));
    for (const market of markets) {
      const expected = SYMBOL_PRECISION[precisionKey('binance', market.symbol)];
      expect(expected).toBeDefined();
      expect(market.pricePrecision).toBe(expected?.price);
      expect(market.qtyPrecision).toBe(expected?.qty);
    }
  });

  it('un par no declarado cae a la precision por defecto', () => {
    const markets = marketsOf(listMarkets(deps(['DOGEUSDT'])));
    expect(markets[0]?.pricePrecision).toBe(DEFAULT_PRICE_PRECISION);
    expect(markets[0]?.qtyPrecision).toBe(DEFAULT_QTY_PRECISION);
  });

  it('una precision inyectada explicitamente gana sobre el mapa', () => {
    const markets = marketsOf(
      listMarkets(deps(['SOLUSDT'], { 'binance/SOLUSDT': { price: 9, qty: 9 } })),
    );
    expect(markets[0]?.pricePrecision).toBe(9);
    expect(markets[0]?.qtyPrecision).toBe(9);
  });
});
