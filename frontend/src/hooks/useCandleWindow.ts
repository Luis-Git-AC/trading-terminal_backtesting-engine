import { useState } from 'react';
import { CANDLES_MAX_LIMIT, alignTs, timeframeToMs, type Candle, type Timeframe } from '@tt/shared';
import type { ApiError } from '@/api/errors';
import type { CandlesRequest } from '@/api/resources';
import { useCandles } from '@/hooks/useCandles';
import { useCoverage } from '@/hooks/useMarkets';

export const INITIAL_BARS = 500;
export const PAGE_BARS = 500;

export function candleWindow(
  symbol: string,
  timeframe: Timeframe,
  bars: number,
  anchorMs: number,
): CandlesRequest {
  const step = timeframeToMs(timeframe);
  const to = alignTs(anchorMs, timeframe) + step;
  return { symbol, timeframe, from: to - bars * step, to, limit: bars };
}

export interface UseCandleWindowResult {
  readonly candles: readonly Candle[];
  readonly isPending: boolean;
  readonly error: ApiError | null;
  readonly bars: number;
  readonly canLoadOlder: boolean;
  readonly loadOlder: () => void;
}

export function useCandleWindow(
  symbol: string | undefined,
  timeframe: Timeframe | undefined,
): UseCandleWindowResult {
  const [bars, setBars] = useState(INITIAL_BARS);

  const [tracked, setTracked] = useState(`${symbol ?? ''}:${timeframe ?? ''}`);
  const series = `${symbol ?? ''}:${timeframe ?? ''}`;

  if (tracked !== series) {
    setTracked(series);
    setBars(INITIAL_BARS);
  }

  const coverage = useCoverage(symbol, timeframe);
  const anchorIso = coverage.data?.to ?? null;
  const anchorMs = anchorIso === null ? null : Date.parse(anchorIso);

  const request =
    symbol === undefined || timeframe === undefined || anchorMs === null
      ? undefined
      : candleWindow(symbol, timeframe, bars, anchorMs);

  const candlesQuery = useCandles(request);

  return {
    candles: candlesQuery.data?.candles ?? [],
    isPending: coverage.isPending || candlesQuery.isPending,
    error: coverage.error ?? candlesQuery.error,
    bars,
    canLoadOlder: bars < CANDLES_MAX_LIMIT,
    loadOlder: () => {
      setBars((current) => Math.min(CANDLES_MAX_LIMIT, current + PAGE_BARS));
    },
  };
}
