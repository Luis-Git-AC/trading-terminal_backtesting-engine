import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import type { Candle } from '@tt/shared';

export const REFERENCE_WINDOW_MS = 24 * 60 * 60 * 1000;

export type PriceDirection = 'up' | 'down' | 'flat';

export interface LivePrice {
  readonly symbol: string;
  readonly price: number;
  readonly referencePrice: number | null;
  readonly direction: PriceDirection;
  readonly seq: number;
}

export interface LivePriceUpdate {
  readonly symbol: string;
  readonly candle: Candle;
  readonly referencePrice: number | null;
}

export type PublishLivePrice = (update: LivePriceUpdate | null) => void;

export function referenceClose(
  candles: readonly Candle[],
  windowMs: number = REFERENCE_WINDOW_MS,
): number | null {
  const last = candles.at(-1);

  if (last === undefined) {
    return null;
  }

  const cutoff = last.t - windowMs;
  let reference: Candle | undefined;

  for (const candle of candles) {
    if (candle.t > cutoff) {
      break;
    }
    reference = candle;
  }

  return reference?.c ?? null;
}

export function changePct(price: number, referencePrice: number | null): number | null {
  if (referencePrice === null || referencePrice === 0) {
    return null;
  }
  return ((price - referencePrice) / referencePrice) * 100;
}

export function nextLivePrice(
  previous: LivePrice | null,
  update: LivePriceUpdate | null,
): LivePrice | null {
  if (update === null) {
    return null;
  }

  const price = update.candle.c;
  const direction: PriceDirection =
    previous?.symbol !== update.symbol || previous.price === price
      ? 'flat'
      : price > previous.price
        ? 'up'
        : 'down';

  return {
    symbol: update.symbol,
    price,
    referencePrice: update.referencePrice,
    direction,
    seq: (previous?.seq ?? 0) + 1,
  };
}

const LivePriceContext = createContext<LivePrice | null>(null);

const PublishLivePriceContext = createContext<PublishLivePrice>(() => undefined);

export function LivePriceProvider({ children }: { children: ReactNode }) {
  const [livePrice, setLivePrice] = useState<LivePrice | null>(null);

  const publish = useCallback<PublishLivePrice>((update) => {
    setLivePrice((previous) => nextLivePrice(previous, update));
  }, []);

  return (
    <PublishLivePriceContext value={publish}>
      <LivePriceContext value={livePrice}>{children}</LivePriceContext>
    </PublishLivePriceContext>
  );
}

export function useLivePrice(): LivePrice | null {
  return useContext(LivePriceContext);
}

export function usePublishLivePrice(): PublishLivePrice {
  return useContext(PublishLivePriceContext);
}
