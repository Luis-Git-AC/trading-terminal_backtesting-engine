import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TIMEFRAMES } from '@tt/shared';
import { createFakeSocketFactory, type FakeSocketFactory } from '../../../testing/fake-socket.js';
import type { ExchangeStreamEvent } from '../adapter.js';
import { createBinanceCandleStream } from './ws.js';
import {
  BINANCE_WS_MAX_LIFETIME_MS,
  buildSubscribeMessage,
  buildUnsubscribeMessage,
  fromInterval,
  parseBinanceWsMessage,
  toStreamName,
} from './ws-normalize.js';

function loadFixture(name: string): string {
  const url = new URL(`../../../__fixtures__/binance/${name}.json`, import.meta.url);
  return readFileSync(url, 'utf8');
}

const ACK = loadFixture('ws-ack');
const FORMING = loadFixture('ws-kline-forming');
const CLOSED = loadFixture('ws-kline-closed');
const WS_ERROR = loadFixture('ws-error');

interface Harness {
  readonly fakes: FakeSocketFactory;
  readonly events: ExchangeStreamEvent[];
  readonly stream: ReturnType<typeof createBinanceCandleStream>;
  push(message: string): void;
  candles(): { t: number; c: number; closed: boolean }[];
}

function harness(): Harness {
  const fakes = createFakeSocketFactory();
  const events: ExchangeStreamEvent[] = [];
  const stream = createBinanceCandleStream({
    url: 'ws://local.test',
    createSocket: fakes.factory,
    staleTimeoutMs: 0,
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

function connected(): Harness {
  const h = harness();
  h.stream.subscribe('BTCUSDT', '1m');
  h.stream.connect();
  h.fakes.last().emitOpen();
  return h;
}

describe('protocolo WS de Binance', () => {
  it('construye el nombre del stream en minuscula, como exige Binance', () => {
    expect(toStreamName('BTCUSDT', '15m')).toBe('btcusdt@kline_15m');
    expect(toStreamName('BTCUSDT', '1h')).toBe('btcusdt@kline_1h');
  });

  it('el mapeo intervalo -> timeframe es la inversa exacta', () => {
    for (const timeframe of TIMEFRAMES) {
      expect(fromInterval(toStreamName('X', timeframe).split('_')[1] ?? '')).toBe(timeframe);
    }
    expect(fromInterval('4h')).toBeUndefined();
  });

  it('suscribe y desuscribe con el metodo y el id del contrato', () => {
    expect(JSON.parse(buildSubscribeMessage('BTCUSDT', '1m', 7))).toEqual({
      method: 'SUBSCRIBE',
      params: ['btcusdt@kline_1m'],
      id: 7,
    });
    expect(JSON.parse(buildUnsubscribeMessage('BTCUSDT', '1m', 8))).toEqual({
      method: 'UNSUBSCRIBE',
      params: ['btcusdt@kline_1m'],
      id: 8,
    });
  });

  it('distingue ack, error y push; lo demas es protocolo desconocido', () => {
    expect(parseBinanceWsMessage(ACK)).toEqual({ kind: 'ack', id: 1 });
    expect(parseBinanceWsMessage(WS_ERROR).kind).toBe('error');
    expect(parseBinanceWsMessage(FORMING).kind).toBe('push');
    expect(parseBinanceWsMessage('no es json').kind).toBe('unparsable');
    expect(parseBinanceWsMessage('{"otra":"cosa"}').kind).toBe('unparsable');
  });
});

describe('createBinanceCandleStream', () => {
  it('manda la suscripcion al abrir el socket', () => {
    const h = connected();

    expect(h.fakes.last().sent).toEqual([buildSubscribeMessage('BTCUSDT', '1m', 1)]);
  });

  it('el ack se traduce a subscribed con su serie', () => {
    const h = connected();

    h.push(ACK);

    expect(h.events.filter((event) => event.kind === 'subscribed')).toEqual([
      { kind: 'subscribed', symbol: 'BTCUSDT', timeframe: '1m' },
    ]);
  });

  it('la vela en formacion llega con closed=false y la cerrada con closed=true', () => {
    const h = connected();

    h.push(FORMING);
    h.push(CLOSED);

    expect(h.candles()).toEqual([
      { t: 1_767_225_600_000, c: 87_650.1, closed: false },
      { t: 1_767_225_600_000, c: 87_705, closed: true },
    ]);
  });

  it('tras reconectar, el ack repetido sigue reconociendo la serie', () => {
    const h = connected();

    h.push(ACK);
    h.fakes.last().emitClose(1006, 'corte');
    h.stream.connect();
    h.fakes.last().emitOpen();
    h.push(ACK);

    expect(h.events.filter((event) => event.kind === 'subscribed')).toHaveLength(2);
    expect(h.events.filter((event) => event.kind === 'protocol')).toEqual([]);
  });

  it('una kline corrupta se descarta con su razon y no emite vela', () => {
    const h = connected();

    h.push(
      JSON.stringify({
        stream: 'btcusdt@kline_1m',
        data: {
          e: 'kline',
          s: 'BTCUSDT',
          k: {
            t: 1_767_225_630_000,
            T: 1_767_225_689_999,
            i: '1m',
            o: '1',
            h: '1',
            l: '1',
            c: '1',
            v: '1',
            q: '1',
            x: true,
          },
        },
      }),
    );

    expect(h.candles()).toEqual([]);
    const discarded = h.events.find((event) => event.kind === 'discarded');
    expect(discarded?.kind === 'discarded' ? discarded.rows[0]?.reason : null).toBe('unaligned');
  });

  it('un error del exchange se emite como rejected', () => {
    const h = connected();

    h.push(WS_ERROR);

    const rejected = h.events.find((event) => event.kind === 'rejected');
    expect(rejected?.kind === 'rejected' ? rejected.code : null).toBe('2');
  });
});

describe('reconexion preventiva antes del corte de 24 h', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('recicla el socket antes de las 24 h y vuelve a suscribir', async () => {
    vi.useFakeTimers();

    const fakes = createFakeSocketFactory();
    const events: ExchangeStreamEvent[] = [];
    const stream = createBinanceCandleStream({
      url: 'ws://local.test',
      createSocket: fakes.factory,
      staleTimeoutMs: 0,
      random: () => 0,
    });
    stream.on((event) => events.push(event));

    stream.subscribe('BTCUSDT', '1m');
    stream.connect();
    fakes.last().emitOpen();

    expect(fakes.created).toHaveLength(1);
    expect(BINANCE_WS_MAX_LIFETIME_MS).toBeLessThan(24 * 60 * 60 * 1000);

    await vi.advanceTimersByTimeAsync(BINANCE_WS_MAX_LIFETIME_MS + 1);

    const lifetime = events.find(
      (event) => event.kind === 'socket' && event.event.kind === 'lifetime',
    );
    expect(lifetime).toBeDefined();
    expect(fakes.created).toHaveLength(2);

    fakes.last().emitOpen();
    expect(fakes.last().sent).toEqual([buildSubscribeMessage('BTCUSDT', '1m', 1)]);

    await stream.close();
  });
});
