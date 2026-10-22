import type { Timeframe } from '@tt/shared';
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
  BINANCE_WS_DEFAULT_URL,
  BINANCE_WS_MAX_LIFETIME_MS,
  buildSubscribeMessage,
  buildUnsubscribeMessage,
  fromInterval,
  klineToRow,
  parseBinanceWsMessage,
} from './ws-normalize.js';

export interface BinanceCandleStreamOptions extends ExchangeCandleStreamOptions {
  maxLifetimeMs?: number | undefined;
}

function seriesKey(symbol: string, timeframe: Timeframe): string {
  return `${symbol}|${timeframe}`;
}

export function createBinanceCandleStream(
  options: BinanceCandleStreamOptions = {},
): ExchangeCandleStream {
  const listeners = new Set<ExchangeStreamListener>();
  // id de peticion -> serie, porque el ack de Binance solo trae el id.
  const pending = new Map<number, { symbol: string; timeframe: Timeframe }>();
  let nextId = 1;

  const socket = createResilientSocket({
    url: options.url ?? BINANCE_WS_DEFAULT_URL,
    // Binance hace ping a nivel de protocolo y la libreria responde el pong: no hay ping de aplicacion.
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 0,
    maxLifetimeMs: options.maxLifetimeMs ?? BINANCE_WS_MAX_LIFETIME_MS,
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

  function onMessage(text: string): void {
    const parsed = parseBinanceWsMessage(text);

    if (parsed.kind === 'unparsable') {
      emit({ kind: 'protocol', detail: parsed.detail });
      return;
    }

    if (parsed.kind === 'ack') {
      const series = pending.get(parsed.id);
      pending.delete(parsed.id);
      if (series === undefined) {
        emit({ kind: 'protocol', detail: `ack con id desconocido: ${parsed.id}` });
        return;
      }
      emit({ kind: 'subscribed', symbol: series.symbol, timeframe: series.timeframe });
      return;
    }

    if (parsed.kind === 'error') {
      const series = parsed.id === undefined ? undefined : pending.get(parsed.id);
      if (parsed.id !== undefined) pending.delete(parsed.id);
      emit({ kind: 'rejected', arg: series ?? parsed.id, code: parsed.code, message: parsed.message });
      return;
    }

    const timeframe = fromInterval(parsed.kline.i);
    if (timeframe === undefined) {
      emit({ kind: 'protocol', detail: `intervalo desconocido: ${parsed.kline.i}` });
      return;
    }

    const { candles, discarded } = normalizeCandles([klineToRow(parsed.kline)], timeframe);
    if (discarded.length > 0) {
      emit({ kind: 'discarded', symbol: parsed.symbol, timeframe, rows: discarded });
    }

    for (const candle of candles) {
      emit({
        kind: 'candle',
        symbol: parsed.symbol,
        timeframe,
        candle,
        closed: parsed.kline.x,
      });
    }
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
      const id = nextId;
      nextId += 1;
      pending.set(id, { symbol, timeframe });
      socket.subscribe(seriesKey(symbol, timeframe), buildSubscribeMessage(symbol, timeframe, id));
    },

    unsubscribe(symbol, timeframe) {
      const id = nextId;
      nextId += 1;
      socket.unsubscribe(
        seriesKey(symbol, timeframe),
        buildUnsubscribeMessage(symbol, timeframe, id),
      );
    },

    // Binance marca el cierre en `k.x`, asi que no hace falta cerrar velas por reloj.
    flushExpired() {
      return undefined;
    },

    close() {
      return socket.close();
    },
  };
}
