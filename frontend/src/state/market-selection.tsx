import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { TIMEFRAMES, type Timeframe } from '@tt/shared';

export const FALLBACK_SYMBOLS = ['BTCUSDT', 'ETHUSDT'] as const;

export const DEFAULT_SYMBOL: string = FALLBACK_SYMBOLS[0];
export const DEFAULT_TIMEFRAME: Timeframe = '15m';

export interface MarketSelection {
  symbol: string;
  timeframe: Timeframe;
  symbols: readonly string[];
  timeframes: readonly Timeframe[];
  setSymbol: (symbol: string) => void;
  setTimeframe: (timeframe: Timeframe) => void;
}

const MarketSelectionContext = createContext<MarketSelection | null>(null);

export function MarketSelectionProvider({ children }: { children: ReactNode }) {
  const [symbol, setSymbol] = useState<string>(DEFAULT_SYMBOL);
  const [timeframe, setTimeframe] = useState<Timeframe>(DEFAULT_TIMEFRAME);

  const value = useMemo<MarketSelection>(
    () => ({
      symbol,
      timeframe,
      symbols: FALLBACK_SYMBOLS,
      timeframes: TIMEFRAMES,
      setSymbol,
      setTimeframe,
    }),
    [symbol, timeframe],
  );

  return <MarketSelectionContext value={value}>{children}</MarketSelectionContext>;
}

export function useMarketSelection(): MarketSelection {
  const value = useContext(MarketSelectionContext);
  if (value === null) {
    throw new Error('useMarketSelection debe usarse dentro de <MarketSelectionProvider>');
  }
  return value;
}
