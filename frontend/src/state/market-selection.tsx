import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { DEFAULT_EXCHANGE, TIMEFRAMES, type Exchange, type Timeframe } from '@tt/shared';
import { useMarkets } from '@/hooks/useMarkets';

export const DEFAULT_SYMBOL = 'BTCUSDT';
export const DEFAULT_TIMEFRAME: Timeframe = '15m';

export interface MarketSelection {
  exchange: Exchange;
  symbol: string;
  timeframe: Timeframe;
  exchanges: readonly Exchange[];
  symbols: readonly string[];
  timeframes: readonly Timeframe[];
  isLoading: boolean;
  setExchange: (exchange: Exchange) => void;
  setSymbol: (symbol: string) => void;
  setTimeframe: (timeframe: Timeframe) => void;
}

const MarketSelectionContext = createContext<MarketSelection | null>(null);

export function pickExchange(
  requested: Exchange | null,
  available: readonly Exchange[],
): Exchange {
  if (requested !== null && available.includes(requested)) {
    return requested;
  }
  return available.includes(DEFAULT_EXCHANGE) ? DEFAULT_EXCHANGE : (available[0] ?? DEFAULT_EXCHANGE);
}

export function pickSymbol(requested: string | null, available: readonly string[]): string {
  if (requested !== null && available.includes(requested)) {
    return requested;
  }
  return available[0] ?? DEFAULT_SYMBOL;
}

export function pickTimeframe(
  requested: Timeframe | null,
  available: readonly Timeframe[],
): Timeframe {
  if (requested !== null && available.includes(requested)) {
    return requested;
  }
  return available.includes(DEFAULT_TIMEFRAME) ? DEFAULT_TIMEFRAME : (available[0] ?? '1m');
}

export function MarketSelectionProvider({ children }: { children: ReactNode }) {
  const markets = useMarkets();

  const [requestedExchange, setExchange] = useState<Exchange | null>(null);
  const [requestedSymbol, setSymbol] = useState<string | null>(null);
  const [requestedTimeframe, setTimeframe] = useState<Timeframe | null>(null);

  const value = useMemo<MarketSelection>(() => {
    const served = markets.data?.exchanges ?? [];
    const exchanges = served.map((item) => item.exchange);
    const exchange = pickExchange(requestedExchange, exchanges);
    const symbolsOf = served.find((item) => item.exchange === exchange)?.symbols ?? [];
    const symbols = symbolsOf.map((market) => market.symbol);
    const symbol = pickSymbol(requestedSymbol, symbols);
    const timeframes = symbolsOf.find((market) => market.symbol === symbol)?.timeframes ?? TIMEFRAMES;

    return {
      exchange,
      symbol,
      timeframe: pickTimeframe(requestedTimeframe, timeframes),
      exchanges,
      symbols,
      timeframes,
      isLoading: markets.isPending,
      setExchange,
      setSymbol,
      setTimeframe,
    };
  }, [markets.data, markets.isPending, requestedExchange, requestedSymbol, requestedTimeframe]);

  return <MarketSelectionContext value={value}>{children}</MarketSelectionContext>;
}

export function useMarketSelection(): MarketSelection {
  const value = useContext(MarketSelectionContext);
  if (value === null) {
    throw new Error('useMarketSelection debe usarse dentro de <MarketSelectionProvider>');
  }
  return value;
}
