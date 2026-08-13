import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { TIMEFRAMES, type Timeframe } from '@tt/shared';
import { useMarkets } from '@/hooks/useMarkets';

export const DEFAULT_SYMBOL = 'BTCUSDT';
export const DEFAULT_TIMEFRAME: Timeframe = '15m';

export interface MarketSelection {
  symbol: string;
  timeframe: Timeframe;
  symbols: readonly string[];
  timeframes: readonly Timeframe[];
  isLoading: boolean;
  setSymbol: (symbol: string) => void;
  setTimeframe: (timeframe: Timeframe) => void;
}

const MarketSelectionContext = createContext<MarketSelection | null>(null);

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

  const [requestedSymbol, setSymbol] = useState<string | null>(null);
  const [requestedTimeframe, setTimeframe] = useState<Timeframe | null>(null);

  const value = useMemo<MarketSelection>(() => {
    const served = markets.data?.symbols ?? [];
    const symbols = served.map((market) => market.symbol);
    const symbol = pickSymbol(requestedSymbol, symbols);
    const timeframes = served.find((market) => market.symbol === symbol)?.timeframes ?? TIMEFRAMES;

    return {
      symbol,
      timeframe: pickTimeframe(requestedTimeframe, timeframes),
      symbols,
      timeframes,
      isLoading: markets.isPending,
      setSymbol,
      setTimeframe,
    };
  }, [markets.data, markets.isPending, requestedSymbol, requestedTimeframe]);

  return <MarketSelectionContext value={value}>{children}</MarketSelectionContext>;
}

export function useMarketSelection(): MarketSelection {
  const value = useContext(MarketSelectionContext);
  if (value === null) {
    throw new Error('useMarketSelection debe usarse dentro de <MarketSelectionProvider>');
  }
  return value;
}
