import type { Candle, Timeframe } from '@tt/shared';
import type { CandlesRepository, SeriesRef } from '../db/repositories/candles.repo.js';
import type { IngestStateRepository } from '../db/repositories/ingest-state.repo.js';
import type { CandlePublisher } from '../queue/pubsub.js';
import type { BitgetCandleStream, BitgetStreamEvent } from './exchange/bitget/ws.js';

export const DEFAULT_FLUSH_INTERVAL_MS = 200;
export const DEFAULT_WS_TOUCH_INTERVAL_MS = 10_000;
export const DEFAULT_SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

export interface LiveSeries {
  symbol: string;
  timeframe: Timeframe;
}

export type LiveIngestorEvent =
  | {
      kind: 'flushed';
      symbol: string;
      timeframe: Timeframe;
      candles: number;
      written: number;
      lastTs: number;
    }
  | { kind: 'stream'; event: BitgetStreamEvent }
  | { kind: 'error'; stage: 'flush' | 'publish' | 'touch'; error: Error };

export type LiveIngestorListener = (event: LiveIngestorEvent) => void;

export interface LiveIngestorOptions {
  stream: BitgetCandleStream;
  candles: CandlesRepository;
  state: IngestStateRepository;
  publisher: CandlePublisher;
  series: readonly LiveSeries[];
  exchange?: string | undefined;
  flushIntervalMs?: number;
  wsTouchIntervalMs?: number;
  signals?: readonly NodeJS.Signals[];
  now?: () => number;
}

export interface LiveIngestor {
  readonly pending: number;
  on(listener: LiveIngestorListener): () => void;
  start(): void;
  flush(): Promise<void>;
  stop(): Promise<void>;
}

interface SeriesBuffer {
  symbol: string;
  timeframe: Timeframe;
  closed: Map<number, Candle>;
  lastTouchAt: number;
}

function bufferKey(symbol: string, timeframe: Timeframe): string {
  return `${symbol}|${timeframe}`;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function createLiveIngestor(options: LiveIngestorOptions): LiveIngestor {
  const { stream, candles, state, publisher } = options;
  const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const wsTouchIntervalMs = options.wsTouchIntervalMs ?? DEFAULT_WS_TOUCH_INTERVAL_MS;
  const signals = options.signals ?? DEFAULT_SHUTDOWN_SIGNALS;
  const now = options.now ?? Date.now;
  const exchange = options.exchange;

  const listeners = new Set<LiveIngestorListener>();
  const buffers = new Map<string, SeriesBuffer>();
  const handlers = new Map<NodeJS.Signals, () => void>();

  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> = Promise.resolve();
  let unsubscribeStream: (() => void) | undefined;
  let stopped = false;

  function emit(event: LiveIngestorEvent): void {
    for (const listener of [...listeners]) listener(event);
  }

  function seriesRef(buffer: SeriesBuffer): SeriesRef {
    return { exchange, symbol: buffer.symbol, timeframe: buffer.timeframe };
  }

  function bufferFor(symbol: string, timeframe: Timeframe): SeriesBuffer {
    const key = bufferKey(symbol, timeframe);
    const existing = buffers.get(key);
    if (existing !== undefined) return existing;

    const created: SeriesBuffer = {
      symbol,
      timeframe,
      closed: new Map(),
      lastTouchAt: Number.NEGATIVE_INFINITY,
    };
    buffers.set(key, created);
    return created;
  }

  async function flushBuffer(buffer: SeriesBuffer): Promise<void> {
    if (buffer.closed.size === 0) return;

    const batch = [...buffer.closed.values()].sort((a, b) => a.t - b.t);
    buffer.closed.clear();

    const lastTs = batch[batch.length - 1]?.t;
    if (lastTs === undefined) return;

    try {
      const written = await candles.upsertCandles({
        ...seriesRef(buffer),
        source: 'ws',
        candles: batch,
      });
      await state.setLastCandleTs({ ...seriesRef(buffer), lastCandleTs: lastTs });
      emit({
        kind: 'flushed',
        symbol: buffer.symbol,
        timeframe: buffer.timeframe,
        candles: batch.length,
        written,
        lastTs,
      });
    } catch (error) {
      for (const candle of batch) buffer.closed.set(candle.t, candle);
      emit({ kind: 'error', stage: 'flush', error: toError(error) });
    }
  }

  function clearFlushTimer(): void {
    if (flushTimer === undefined) return;
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }

  function flushAll(): Promise<void> {
    clearFlushTimer();
    inFlight = inFlight.then(async () => {
      for (const buffer of buffers.values()) await flushBuffer(buffer);
    });
    return inFlight;
  }

  function scheduleFlush(): void {
    if (flushTimer !== undefined || stopped) return;
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void flushAll();
    }, flushIntervalMs);
  }

  async function touchWs(buffer: SeriesBuffer, at: number): Promise<void> {
    if (at - buffer.lastTouchAt < wsTouchIntervalMs) return;
    buffer.lastTouchAt = at;
    try {
      await state.touchWsMessage({ ...seriesRef(buffer), at });
    } catch (error) {
      emit({ kind: 'error', stage: 'touch', error: toError(error) });
    }
  }

  function onStreamEvent(event: BitgetStreamEvent): void {
    if (event.kind !== 'candle') {
      emit({ kind: 'stream', event });
      return;
    }

    const buffer = bufferFor(event.symbol, event.timeframe);
    const at = now();

    void touchWs(buffer, at);

    void publisher
      .publishCandle(event.symbol, event.timeframe, event.candle, event.closed)
      .catch((error: unknown) => {
        emit({ kind: 'error', stage: 'publish', error: toError(error) });
      });

    if (!event.closed) return;

    buffer.closed.set(event.candle.t, event.candle);
    scheduleFlush();
  }

  return {
    get pending() {
      let total = 0;
      for (const buffer of buffers.values()) total += buffer.closed.size;
      return total;
    },

    on(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    start() {
      stopped = false;
      unsubscribeStream ??= stream.on(onStreamEvent);

      for (const { symbol, timeframe } of options.series) {
        bufferFor(symbol, timeframe);
        stream.subscribe(symbol, timeframe);
      }

      for (const signal of signals) {
        if (handlers.has(signal)) continue;
        const handler = (): void => {
          void flushAll();
        };
        handlers.set(signal, handler);
        process.on(signal, handler);
      }

      stream.connect();
    },

    flush() {
      return flushAll();
    },

    async stop() {
      stopped = true;
      clearFlushTimer();

      for (const [signal, handler] of handlers) process.off(signal, handler);
      handlers.clear();

      unsubscribeStream?.();
      unsubscribeStream = undefined;

      await stream.close();
      await flushAll();
      await publisher.close();
    },
  };
}
