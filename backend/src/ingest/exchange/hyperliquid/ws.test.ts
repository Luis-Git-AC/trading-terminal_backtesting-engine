import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TIMEFRAMES } from '@tt/shared';
import { createFakeSocketFactory, type FakeSocketFactory } from '../../../testing/fake-socket.js';
import type { ExchangeStreamEvent } from '../adapter.js';
import { fromInterval, toInterval } from './types.js';
import { createHyperliquidCandleStream } from './ws.js';
import {
  HYPERLIQUID_WS_PING,
  HYPERLIQUID_WS_PING_MAX_MS,
  buildSubscribeMessage,
  buildUnsubscribeMessage,
  parseHyperliquidWsMessage,
} from './ws-normalize.js';

function loadFixture(name: string): string {
  const url = new URL(`../../../__fixtures__/hyperliquid/${name}.json`, import.meta.url);
  return readFileSync(url, 'utf8');
}

const SUB_RESPONSE = loadFixture('ws-subscription-response');
const PONG = loadFixture('ws-pong');
const CANDLE_1 = loadFixture('ws-candle-1');
const CANDLE_2 = loadFixture('ws-candle-2');
const WS_ERROR = loadFixture('ws-error');

const TS = 1_792_670_640_000;
const STEP = 60_000;

interface Harness {
  readonly fakes: FakeSocketFactory;
  readonly events: ExchangeStreamEvent[];
  readonly stream: ReturnType<typeof createHyperliquidCandleStream>;
  push(message: string): void;
  candles(): { t: number; c: number; closed: boolean }[];
}

function harness(options: { now?: () => number } = {}): Harness {
  const fakes = createFakeSocketFactory();
  const events: ExchangeStreamEvent[] = [];
  const stream = createHyperliquidCandleStream({
    url: 'ws://local.test',
    createSocket: fakes.factory,
    staleTimeoutMs: 0,
    heartbeatIntervalMs: 0,
    now: options.now ?? (() => TS),
  });

  stream.on((event) => events.push(event));

  return {
    fakes,
    events,
    stream,
    push(message) {
      fakes.last().emitMessage(message);
    },
    candles() {
      return events.flatMap((event) =>
        event.kind === 'candle'
          ? [{ t: event.candle.t, c: event.candle.c, closed: event.closed }]
          : [],
      );
    },
  };
}

function connected(options: { now?: () => number } = {}): Harness {
  const h = harness(options);
  h.stream.subscribe('BTC', '1m');
  h.stream.connect();
  h.fakes.last().emitOpen();
  return h;
}

describe('protocolo WS de Hyperliquid', () => {
  it('suscribe y desuscribe con la forma del contrato', () => {
    expect(JSON.parse(buildSubscribeMessage('BTC', '1m'))).toEqual({
      method: 'subscribe',
      subscription: { type: 'candle', coin: 'BTC', interval: '1m' },
    });
    expect(JSON.parse(buildUnsubscribeMessage('BTC', '15m'))).toEqual({
      method: 'unsubscribe',
      subscription: { type: 'candle', coin: 'BTC', interval: '15m' },
    });
  });

  it('el mapeo intervalo -> timeframe es la inversa exacta', () => {
    for (const timeframe of TIMEFRAMES) {
      expect(fromInterval(toInterval(timeframe))).toBe(timeframe);
    }
    expect(fromInterval('4h')).toBeUndefined();
  });

  it('distingue pong, confirmacion, error y vela', () => {
    expect(parseHyperliquidWsMessage(PONG)).toEqual({ kind: 'pong' });
    expect(parseHyperliquidWsMessage(SUB_RESPONSE)).toEqual({
      kind: 'subscribed',
      symbol: 'BTC',
      timeframe: '1m',
    });
    expect(parseHyperliquidWsMessage(WS_ERROR).kind).toBe('error');
    expect(parseHyperliquidWsMessage(CANDLE_1).kind).toBe('candle');
    expect(parseHyperliquidWsMessage('no es json').kind).toBe('unparsable');
    expect(parseHyperliquidWsMessage('{"channel":"trades","data":[]}').kind).toBe('unparsable');
  });
});

describe('createHyperliquidCandleStream', () => {
  it('manda la suscripcion al abrir y el ping aplicativo por debajo del minuto', () => {
    const h = connected();

    expect(h.fakes.last().sent).toEqual([buildSubscribeMessage('BTC', '1m')]);
    expect(JSON.parse(HYPERLIQUID_WS_PING)).toEqual({ method: 'ping' });
    expect(HYPERLIQUID_WS_PING_MAX_MS).toBeLessThan(60_000);
  });

  it('una sola conexion para varios simbolos y timeframes', () => {
    const h = harness();

    h.stream.subscribe('BTC', '1m');
    h.stream.subscribe('ETH', '1m');
    h.stream.subscribe('SOL', '15m');
    h.stream.connect();
    h.fakes.last().emitOpen();

    expect(h.fakes.created).toHaveLength(1);
    expect(h.fakes.last().sent).toHaveLength(3);
  });

  it('el pong no se confunde con una vela ni ensucia el log de protocolo', () => {
    const h = connected();

    h.push(PONG);

    expect(h.candles()).toEqual([]);
    expect(h.events.filter((event) => event.kind === 'protocol')).toEqual([]);
  });

  it('la vela en formacion se emite sin cerrar y solo se cierra al saltar el ts', () => {
    const h = connected();

    h.push(CANDLE_1);
    h.push(CANDLE_2);

    expect(h.candles()).toEqual([
      { t: TS, c: 81_715, closed: false },
      { t: TS, c: 81_715, closed: false },
    ]);

    h.push(CANDLE_1.replace(String(TS), String(TS + STEP)).replace(`"${TS + 59_999}"`, `"${TS + STEP + 59_999}"`));

    const closed = h.candles().filter((candle) => candle.closed);
    expect(closed).toEqual([{ t: TS, c: 81_715, closed: true }]);
  });

  it('flushExpired cierra la vela cuyo periodo ya paso', () => {
    const h = connected();

    h.push(CANDLE_1);
    h.stream.flushExpired(TS + STEP);

    expect(h.candles().filter((candle) => candle.closed)).toEqual([
      { t: TS, c: 81_715, closed: true },
    ]);
  });

  it('un error del exchange se emite como rejected', () => {
    const h = connected();

    h.push(WS_ERROR);

    const rejected = h.events.find((event) => event.kind === 'rejected');
    expect(rejected?.kind === 'rejected' ? rejected.message : '').toContain('Error parsing JSON');
  });

  it('una vela con forma inesperada se reporta como protocolo, no como vela', () => {
    const h = connected();

    h.push('{"channel":"candle","data":{"t":1,"s":"BTC","i":"1m"}}');

    expect(h.candles()).toEqual([]);
    expect(h.events.some((event) => event.kind === 'protocol')).toBe(true);
  });
});

describe('watchdog', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sin trafico durante el stale timeout reconecta y vuelve a suscribir', async () => {
    vi.useFakeTimers();

    const fakes = createFakeSocketFactory();
    const stream = createHyperliquidCandleStream({
      url: 'ws://local.test',
      createSocket: fakes.factory,
      staleTimeoutMs: 1000,
      heartbeatIntervalMs: 0,
      reconnectBaseMs: 10,
      reconnectMaxMs: 20,
      random: () => 0,
    });

    stream.subscribe('BTC', '1m');
    stream.connect();
    fakes.last().emitOpen();

    await vi.advanceTimersByTimeAsync(1500);

    expect(fakes.created).toHaveLength(2);
    fakes.last().emitOpen();
    expect(fakes.last().sent).toEqual([buildSubscribeMessage('BTC', '1m')]);

    await stream.close();
  });
});
