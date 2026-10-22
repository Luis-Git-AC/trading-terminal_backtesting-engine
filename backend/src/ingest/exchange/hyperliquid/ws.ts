import { timeframeToMs, type Candle, type Timeframe } from '@tt/shared';
import {
  createResilientSocket,
  createWebSocketFactory,
  DEFAULT_MAX_CONSECUTIVE_FAILURES,
  DEFAULT_RECONNECT_BASE_MS,
  DEFAULT_RECONNECT_MAX_MS,
  DEFAULT_STABLE_RESET_MS,
  DEFAULT_STALE_TIMEOUT_MS,
} from '../../ws/resilient-socket.js';
import type {
  ExchangeCandleStream,
  ExchangeCandleStreamOptions,
  ExchangeStreamEvent,
  ExchangeStreamListener,
} from '../adapter.js';
import { normalizeCandles } from './normalize.js';
import {
  HYPERLIQUID_WS_DEFAULT_URL,
  HYPERLIQUID_WS_PING,
  HYPERLIQUID_WS_PING_INTERVAL_MS,
  HYPERLIQUID_WS_PING_MAX_MS,
  buildAssetCtxSubscribeMessage,
  buildSubscribeMessage,
  buildUnsubscribeMessage,
  parseHyperliquidWsMessage,
} from './ws-normalize.js';

interface SeriesState {
  symbol: string;
  timeframe: Timeframe;
  forming: Candle | undefined;
  lastClosedTs: number | undefined;
}

function seriesKey(symbol: string, timeframe: Timeframe): string {
  return `${symbol}|${timeframe}`;
}

export function createHyperliquidCandleStream(
  options: ExchangeCandleStreamOptions = {},
): ExchangeCandleStream {
  const now = options.now ?? Date.now;
  const listeners = new Set<ExchangeStreamListener>();
  const series = new Map<string, SeriesState>();

  const socket = createResilientSocket({
    url: options.url ?? HYPERLIQUID_WS_DEFAULT_URL,
    heartbeatMessage: HYPERLIQUID_WS_PING,
    // El pong llega como {"channel":"pong"} y lo trata onMessage; comparar el texto seria fragil.
    heartbeatIntervalMs: Math.min(
      options.heartbeatIntervalMs ?? HYPERLIQUID_WS_PING_INTERVAL_MS,
      HYPERLIQUID_WS_PING_MAX_MS,
    ),
    reconnectBaseMs: options.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS,
    reconnectMaxMs: options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS,
    staleTimeoutMs: options.staleTimeoutMs ?? DEFAULT_STALE_TIMEOUT_MS,
    stableResetMs: options.stableResetMs ?? DEFAULT_STABLE_RESET_MS,
    maxConsecutiveFailures: options.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES,
    createSocket: options.createSocket ?? createWebSocketFactory(),
    random: options.random ?? Math.random,
  });

  function emit(event: ExchangeStreamEvent): void {
    for (const listener of [...listeners]) listener(event);
  }

  function stateFor(symbol: string, timeframe: Timeframe): SeriesState {
    const key = seriesKey(symbol, timeframe);
    const existing = series.get(key);
    if (existing !== undefined) return existing;

    const created: SeriesState = { symbol, timeframe, forming: undefined, lastClosedTs: undefined };
    series.set(key, created);
    return created;
  }

  function closeForming(state: SeriesState): void {
    const forming = state.forming;
    if (forming === undefined) return;

    state.forming = undefined;
    state.lastClosedTs = forming.t;
    emit({
      kind: 'candle',
      symbol: state.symbol,
      timeframe: state.timeframe,
      candle: forming,
      closed: true,
    });
  }

  function expireByClock(state: SeriesState, nowMs: number): void {
    const forming = state.forming;
    if (forming === undefined) return;
    if (nowMs < forming.t + timeframeToMs(state.timeframe)) return;
    closeForming(state);
  }

  /** Hyperliquid no marca el cierre: la vela anterior se cierra cuando `t` salta. */
  function ingest(state: SeriesState, candles: readonly Candle[]): void {
    for (const candle of candles) {
      if (state.lastClosedTs !== undefined && candle.t <= state.lastClosedTs) continue;

      const forming = state.forming;
      if (forming !== undefined && candle.t < forming.t) continue;
      if (forming !== undefined && candle.t > forming.t) closeForming(state);

      state.forming = candle;
      emit({
        kind: 'candle',
        symbol: state.symbol,
        timeframe: state.timeframe,
        candle,
        closed: false,
      });
    }
  }

  function onMessage(text: string): void {
    const parsed = parseHyperliquidWsMessage(text);

    if (parsed.kind === 'pong') return;

    if (parsed.kind === 'unparsable') {
      emit({ kind: 'protocol', detail: parsed.detail });
      return;
    }

    if (parsed.kind === 'subscribed') {
      stateFor(parsed.symbol, parsed.timeframe);
      emit({ kind: 'subscribed', symbol: parsed.symbol, timeframe: parsed.timeframe });
      return;
    }

    if (parsed.kind === 'subscribed-ctx') {
      emit({ kind: 'subscribedCtx', symbol: parsed.symbol });
      return;
    }

    if (parsed.kind === 'asset-ctx') {
      emit({
        kind: 'assetCtx',
        symbol: parsed.symbol,
        funding: parsed.funding,
        openInterest: parsed.openInterest,
      });
      return;
    }

    if (parsed.kind === 'error') {
      emit({ kind: 'rejected', arg: null, code: 'error', message: parsed.message });
      return;
    }

    const state = stateFor(parsed.symbol, parsed.timeframe);
    expireByClock(state, now());

    const { candles, discarded } = normalizeCandles([parsed.row], parsed.timeframe);
    if (discarded.length > 0) {
      emit({ kind: 'discarded', symbol: state.symbol, timeframe: parsed.timeframe, rows: discarded });
    }

    ingest(state, candles);
  }

  socket.on((event) => {
    if (event.kind === 'message') {
      onMessage(event.data);
      return;
    }
    emit({ kind: 'socket', event });
  });

  return {
    socket,

    on(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    connect() {
      socket.connect();
    },

    subscribe(symbol, timeframe) {
      stateFor(symbol, timeframe);
      socket.subscribe(seriesKey(symbol, timeframe), buildSubscribeMessage(symbol, timeframe));
    },

    subscribeAssetCtx(symbol) {
      // Va por el mismo socket que las velas: la suscripcion es otro mensaje, no otra conexion.
      socket.subscribe(`ctx|${symbol}`, buildAssetCtxSubscribeMessage(symbol));
    },

    unsubscribe(symbol, timeframe) {
      series.delete(seriesKey(symbol, timeframe));
      socket.unsubscribe(seriesKey(symbol, timeframe), buildUnsubscribeMessage(symbol, timeframe));
    },

    flushExpired(nowMs) {
      const at = nowMs ?? now();
      for (const state of series.values()) expireByClock(state, at);
    },

    close() {
      return socket.close();
    },
  };
}
