import { timeframeToMs, type Candle, type Timeframe } from '@tt/shared';
import {
  createResilientSocket,
  createWebSocketFactory,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
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
  BITGET_WS_DEFAULT_URL,
  BITGET_WS_INST_TYPE,
  BITGET_WS_PING,
  BITGET_WS_PONG,
  buildSubscribeMessage,
  buildUnsubscribeMessage,
  fromCandleChannel,
  parseBitgetWsMessage,
  type BitgetWsArg,
} from './ws-normalize.js';

export type {
  ExchangeCandleStream as BitgetCandleStream,
  ExchangeStreamEvent as BitgetStreamEvent,
  ExchangeStreamListener as BitgetStreamListener,
} from '../adapter.js';

export interface BitgetCandleStreamOptions extends ExchangeCandleStreamOptions {
  instType?: string | undefined;
}

interface SeriesState {
  symbol: string;
  timeframe: Timeframe;
  forming: Candle | undefined;
  lastClosedTs: number | undefined;
}

function seriesKey(symbol: string, timeframe: Timeframe): string {
  return `${symbol}|${timeframe}`;
}

export function createBitgetCandleStream(
  options: BitgetCandleStreamOptions = {},
): ExchangeCandleStream {
  const instType = options.instType ?? BITGET_WS_INST_TYPE;
  const now = options.now ?? Date.now;
  const listeners = new Set<ExchangeStreamListener>();
  const series = new Map<string, SeriesState>();

  const socket = createResilientSocket({
    url: options.url ?? BITGET_WS_DEFAULT_URL,
    heartbeatMessage: BITGET_WS_PING,
    heartbeatResponse: BITGET_WS_PONG,
    reconnectBaseMs: options.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS,
    reconnectMaxMs: options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS,
    staleTimeoutMs: options.staleTimeoutMs ?? DEFAULT_STALE_TIMEOUT_MS,
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
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

    const created: SeriesState = {
      symbol,
      timeframe,
      forming: undefined,
      lastClosedTs: undefined,
    };
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

  function onControl(
    event: string,
    arg: BitgetWsArg | undefined,
    code: string | undefined,
    message: string | undefined,
  ): void {
    if (event === 'error') {
      emit({
        kind: 'rejected',
        arg,
        code: code ?? 'desconocido',
        message: message ?? 'Bitget rechazo la operacion sin mensaje',
      });
      return;
    }

    if (event !== 'subscribe') {
      emit({ kind: 'protocol', detail: `evento de control no manejado: ${event}` });
      return;
    }

    const timeframe = arg === undefined ? undefined : fromCandleChannel(arg.channel);
    if (arg === undefined || timeframe === undefined) {
      emit({ kind: 'protocol', detail: `confirmacion de suscripcion sin canal de velas conocido` });
      return;
    }

    emit({ kind: 'subscribed', symbol: arg.instId, timeframe });
  }

  function onMessage(text: string): void {
    const parsed = parseBitgetWsMessage(text);

    if (parsed.kind === 'pong') return;

    if (parsed.kind === 'unparsable') {
      emit({ kind: 'protocol', detail: parsed.detail });
      return;
    }

    if (parsed.kind === 'control') {
      onControl(parsed.event, parsed.arg, parsed.code, parsed.message);
      return;
    }

    const timeframe = fromCandleChannel(parsed.arg.channel);
    if (timeframe === undefined) {
      emit({ kind: 'protocol', detail: `canal desconocido: ${parsed.arg.channel}` });
      return;
    }

    const state = stateFor(parsed.arg.instId, timeframe);
    expireByClock(state, now());

    const { candles, discarded } = normalizeCandles(parsed.rows, timeframe);
    if (discarded.length > 0) {
      emit({
        kind: 'discarded',
        symbol: state.symbol,
        timeframe,
        rows: discarded,
      });
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
      socket.subscribe(
        seriesKey(symbol, timeframe),
        buildSubscribeMessage(symbol, timeframe, instType),
      );
    },

    unsubscribe(symbol, timeframe) {
      series.delete(seriesKey(symbol, timeframe));
      socket.unsubscribe(
        seriesKey(symbol, timeframe),
        buildUnsubscribeMessage(symbol, timeframe, instType),
      );
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
