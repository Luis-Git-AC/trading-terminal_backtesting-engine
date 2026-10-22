import { useState } from 'react';
import {
  CANDLES_MAX_LIMIT,
  alignTs,
  timeframeToMs,
  type Candle,
  type Exchange,
  type Timeframe,
} from '@tt/shared';
import type { ApiError } from '@/api/errors';
import type { CandlesRequest } from '@/api/resources';
import { useCandles } from '@/hooks/useCandles';
import { useCoverage } from '@/hooks/useMarkets';

export const INITIAL_BARS = 500;
export const PAGE_BARS = 500;

export function candleWindow(
  exchange: Exchange,
  symbol: string,
  timeframe: Timeframe,
  bars: number,
  anchorMs: number,
): CandlesRequest {
  const step = timeframeToMs(timeframe);
  const to = alignTs(anchorMs, timeframe) + step;
  return { exchange, symbol, timeframe, from: to - bars * step, to, limit: bars };
}

export interface UseCandleWindowResult {
  readonly candles: readonly Candle[];
  readonly isPending: boolean;
  readonly error: ApiError | null;
  readonly bars: number;
  readonly canLoadOlder: boolean;
  readonly loadOlder: () => void;
  readonly isRefetching: boolean;
  readonly refetch: () => void;
}

export function useCandleWindow(
  exchange: Exchange | undefined,
  symbol: string | undefined,
  timeframe: Timeframe | undefined,
): UseCandleWindowResult {
  const [bars, setBars] = useState(INITIAL_BARS);

  const [tracked, setTracked] = useState(`${exchange ?? ''}:${symbol ?? ''}:${timeframe ?? ''}`);
  const series = `${exchange ?? ''}:${symbol ?? ''}:${timeframe ?? ''}`;

  if (tracked !== series) {
    setTracked(series);
    setBars(INITIAL_BARS);
  }

  const hasSeries = exchange !== undefined && symbol !== undefined && timeframe !== undefined;

  const coverage = useCoverage(exchange, symbol, timeframe);
  const anchorIso = coverage.data?.to ?? null;
  const anchorMs = anchorIso === null ? null : Date.parse(anchorIso);

  const request =
    !hasSeries || anchorMs === null
      ? undefined
      : candleWindow(exchange, symbol, timeframe, bars, anchorMs);

  const candlesQuery = useCandles(request);

  return {
    candles: candlesQuery.data?.candles ?? [],
    // Una query con skipToken se queda en pending para siempre. Sin serie o sin
    // velas que anclar no hay nada que esperar: si no lo descontamos, la vista se
    // queda en el skeleton y nunca llega al estado vacio que explica que falta el backfill.
    isPending:
      (hasSeries && coverage.isPending) || (request !== undefined && candlesQuery.isPending),
    error: coverage.error ?? candlesQuery.error,
    bars,
    canLoadOlder: bars < CANDLES_MAX_LIMIT,
    loadOlder: () => {
      setBars((current) => Math.min(CANDLES_MAX_LIMIT, current + PAGE_BARS));
    },
    isRefetching: coverage.isRefetching || candlesQuery.isRefetching,
    refetch: () => {
      void coverage.refetch();
      void candlesQuery.refetch();
    },
  };
}
