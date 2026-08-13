import { useState } from 'react';
import type { Candle, Timeframe } from '@tt/shared';
import { candleStreamUrl, type SseConnectionCtor } from '@/api/event-source';
import { candlePayloadSchema, type CandlePayload } from '@/api/sse-events';
import { sseEvent, useEventSource, type ConnectionState } from '@/hooks/useEventSource';

export function tickToCandle(tick: CandlePayload): Candle {
  return { t: tick.t, o: tick.o, h: tick.h, l: tick.l, c: tick.c, v: tick.v };
}

export interface UseLiveCandlesResult {
  readonly forming: Candle | undefined;
  readonly lastClosed: Candle | undefined;
  readonly connectionState: ConnectionState;
}

export interface UseLiveCandlesOptions {
  readonly onTick?: ((candle: Candle, closed: boolean) => void) | undefined;
  readonly enabled?: boolean;
  readonly ctor?: SseConnectionCtor | undefined;
}

export function useLiveCandles(
  symbol: string | undefined,
  timeframe: Timeframe | undefined,
  options: UseLiveCandlesOptions = {},
): UseLiveCandlesResult {
  const [forming, setForming] = useState<Candle | undefined>(undefined);
  const [lastClosed, setLastClosed] = useState<Candle | undefined>(undefined);

  const [tracked, setTracked] = useState(`${symbol ?? ''}:${timeframe ?? ''}`);
  const series = `${symbol ?? ''}:${timeframe ?? ''}`;

  if (tracked !== series) {
    setTracked(series);
    setForming(undefined);
    setLastClosed(undefined);
  }

  const { onTick } = options;

  const handlers = {
    candle: sseEvent(candlePayloadSchema, (tick) => {
      const candle = tickToCandle(tick);

      if (tick.closed) {
        setLastClosed(candle);
        setForming(undefined);
      } else {
        setForming(candle);
      }

      onTick?.(candle, tick.closed);
    }),
  };

  const url =
    symbol === undefined || timeframe === undefined
      ? undefined
      : candleStreamUrl(symbol, timeframe);

  const { connectionState } = useEventSource(url, handlers, {
    enabled: options.enabled ?? true,
    ctor: options.ctor,
  });

  return { forming, lastClosed, connectionState };
}
