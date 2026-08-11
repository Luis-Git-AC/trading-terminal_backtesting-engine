import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TIMEFRAMES, type Candle, type Timeframe } from '@tt/shared';
import {
  createFakeSocketFactory,
  type FakeSocketFactory,
} from '../../../testing/fake-socket.js';
import { createBitgetCandleStream, type BitgetStreamEvent } from './ws.js';
import {
  BITGET_WS_PONG,
  buildSubscribeMessage,
  buildUnsubscribeMessage,
  fromCandleChannel,
  parseBitgetWsMessage,
  toCandleChannel,
} from './ws-normalize.js';

function loadFixture(name: string): string {
  const url = new URL(`../../../__fixtures__/bitget/${name}.json`, import.meta.url);
  return readFileSync(url, 'utf8');
}

const SNAPSHOT_1M = loadFixture('ws-snapshot-1m');
const UPDATE_FORMING = loadFixture('ws-update-forming');
const UPDATE_ROLLOVER = loadFixture('ws-update-rollover');
const EVENT_SUBSCRIBE = loadFixture('ws-event-subscribe');
const EVENT_ERROR = loadFixture('ws-event-error');

const TS_A = 1_786_457_940_000;
const TS_B = 1_786_458_000_000;
const TS_C = 1_786_458_060_000;
const TS_D = 1_786_458_120_000;

interface Harness {
  readonly fakes: FakeSocketFactory;
  readonly events: BitgetStreamEvent[];
  readonly stream: ReturnType<typeof createBitgetCandleStream>;
  push(message: string): void;
  candles(): { t: number; c: number; closed: boolean }[];
  closed(): number[];
}

function harness(options: { now?: () => number } = {}): Harness {
  const fakes = createFakeSocketFactory();
  const events: BitgetStreamEvent[] = [];
  const stream = createBitgetCandleStream({
    url: 'ws://local.test',
    createSocket: fakes.factory,
    staleTimeoutMs: 0,
    heartbeatIntervalMs: 0,
    now: options.now ?? (() => 0),
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
      return events
        .filter((event) => event.kind === 'candle')
        .map((event) =>
          event.kind === 'candle'
            ? { t: event.candle.t, c: event.candle.c, closed: event.closed }
            : { t: -1, c: -1, closed: false },
        );
    },
    closed() {
      return events
        .filter((event) => event.kind === 'candle' && event.closed)
        .map((event) => (event.kind === 'candle' ? event.candle.t : -1));
    },
  };
}

function connected(options: { now?: () => number } = {}): Harness {
  const h = harness(options);
  h.stream.subscribe('BTCUSDT', '1m');
  h.stream.connect();
  h.fakes.last().emitOpen();
  return h;
}

describe('protocolo WS de Bitget', () => {
  describe('canales', () => {
    it('traduce el timeframe al canal respetando las mayusculas de Bitget', () => {
      expect(toCandleChannel('1m')).toBe('candle1m');
      expect(toCandleChannel('15m')).toBe('candle15m');
      expect(toCandleChannel('1h')).toBe('candle1H');
    });

    it('rechaza candle1h en minuscula, que el exchange contesta con 30016', () => {
      expect(fromCandleChannel('candle1h')).toBeUndefined();
      expect(fromCandleChannel('candle1H')).toBe('1h');
    });

    it('el mapeo canal -> timeframe es la inversa exacta para los tres timeframes', () => {
      for (const timeframe of TIMEFRAMES) {
        expect(fromCandleChannel(toCandleChannel(timeframe))).toBe(timeframe);
      }
      expect(fromCandleChannel('candle4H')).toBeUndefined();
      expect(fromCandleChannel('ticker')).toBeUndefined();
    });

    it('construye los mensajes de suscripcion con el instType de futuros', () => {
      expect(JSON.parse(buildSubscribeMessage('BTCUSDT', '1h'))).toEqual({
        op: 'subscribe',
        args: [{ instType: 'USDT-FUTURES', channel: 'candle1H', instId: 'BTCUSDT' }],
      });
      expect(JSON.parse(buildUnsubscribeMessage('ETHUSDT', '15m'))).toEqual({
        op: 'unsubscribe',
        args: [{ instType: 'USDT-FUTURES', channel: 'candle15m', instId: 'ETHUSDT' }],
      });
    });
  });

  describe('parseBitgetWsMessage', () => {
    it('reconoce el pong de texto plano, que no es JSON', () => {
      expect(parseBitgetWsMessage(BITGET_WS_PONG)).toEqual({ kind: 'pong' });
    });

    it('lee la confirmacion de suscripcion real', () => {
      expect(parseBitgetWsMessage(EVENT_SUBSCRIBE)).toEqual({
        kind: 'control',
        event: 'subscribe',
        arg: { instType: 'USDT-FUTURES', channel: 'candle1m', instId: 'BTCUSDT' },
        code: undefined,
        message: undefined,
      });
    });

    it('lee el rechazo real de suscripcion con code numerico', () => {
      expect(parseBitgetWsMessage(EVENT_ERROR)).toEqual({
        kind: 'control',
        event: 'error',
        arg: { instType: 'USDT-FUTURES', channel: 'candle1h', instId: 'BTCUSDT' },
        code: '30016',
        message: 'Param error',
      });
    });

    it('lee el snapshot y el update reales', () => {
      const snapshot = parseBitgetWsMessage(SNAPSHOT_1M);
      const update = parseBitgetWsMessage(UPDATE_FORMING);

      expect(snapshot.kind).toBe('push');
      expect(update.kind).toBe('push');
      if (snapshot.kind !== 'push' || update.kind !== 'push') return;

      expect(snapshot.action).toBe('snapshot');
      expect(snapshot.arg.channel).toBe('candle1m');
      expect(snapshot.rows).toHaveLength(3);
      expect(update.action).toBe('update');
      expect(update.rows).toHaveLength(1);
    });

    it('marca como no interpretable lo que no es JSON ni encaja en el contrato', () => {
      expect(parseBitgetWsMessage('no soy json').kind).toBe('unparsable');
      expect(parseBitgetWsMessage('{"hola":"mundo"}').kind).toBe('unparsable');
      expect(parseBitgetWsMessage('{"action":"snapshot"}').kind).toBe('unparsable');
    });
  });

  describe('normalizacion de los fixtures reales', () => {
    it('convierte las velas del snapshot en velas del dominio pese a los 8 campos', () => {
      const h = connected();
      h.push(SNAPSHOT_1M);

      const candles = h.events
        .filter((event) => event.kind === 'candle' && !event.closed)
        .map((event) => (event.kind === 'candle' ? event.candle : undefined))
        .filter((candle): candle is Candle => candle !== undefined);

      expect(candles).toHaveLength(3);
      expect(candles[0]).toEqual({
        t: TS_A,
        o: 64_166,
        h: 64_166,
        l: 64_123,
        c: 64_123,
        v: 13.5823,
      });
      expect(candles[2]).toEqual({
        t: TS_C,
        o: 64_127.1,
        h: 64_127.2,
        l: 64_100.9,
        c: 64_102.9,
        v: 13.6062,
      });
    });

    it('etiqueta cada vela con su symbol y timeframe', () => {
      const h = connected();
      h.push(UPDATE_FORMING);

      const first = h.events.find((event) => event.kind === 'candle');
      expect(first).toMatchObject({ kind: 'candle', symbol: 'BTCUSDT', timeframe: '1m' });
    });

    it('descarta las filas invalidas sin tirar el resto del mensaje', () => {
      const h = connected();
      h.push(
        JSON.stringify({
          action: 'update',
          arg: { instType: 'USDT-FUTURES', channel: 'candle1m', instId: 'BTCUSDT' },
          data: [
            ['1786458060000', '1', '2', '3'],
            ['1786458061000', '1', '2', '0.5', '1.5', '10'],
            ['1786458060000', '10', '12', '9', '11', '1.5'],
          ],
        }),
      );

      const discarded = h.events.filter((event) => event.kind === 'discarded');
      expect(discarded).toHaveLength(1);
      expect(discarded[0]).toMatchObject({
        kind: 'discarded',
        symbol: 'BTCUSDT',
        timeframe: '1m',
        rows: [
          { index: 0, reason: 'malformed' },
          { index: 1, reason: 'unaligned' },
        ],
      });
      expect(h.candles()).toEqual([{ t: TS_C, c: 11, closed: false }]);
    });
  });

  describe('vela en formacion frente a vela cerrada', () => {
    it('el snapshot cierra todas menos la ultima, que queda en formacion', () => {
      const h = connected();
      h.push(SNAPSHOT_1M);

      expect(h.candles()).toEqual([
        { t: TS_A, c: 64_123, closed: false },
        { t: TS_A, c: 64_123, closed: true },
        { t: TS_B, c: 64_127.1, closed: false },
        { t: TS_B, c: 64_127.1, closed: true },
        { t: TS_C, c: 64_102.9, closed: false },
      ]);
    });

    it('los updates de la misma vela se emiten siempre con closed:false', () => {
      const h = connected();
      h.push(SNAPSHOT_1M);
      h.push(UPDATE_FORMING);
      h.push(UPDATE_FORMING);

      expect(h.closed()).toEqual([TS_A, TS_B]);
      expect(h.candles().slice(-2)).toEqual([
        { t: TS_C, c: 64_103.1, closed: false },
        { t: TS_C, c: 64_103.1, closed: false },
      ]);
    });

    it('al llegar la vela siguiente, la anterior se emite cerrada exactamente una vez', () => {
      const h = connected();
      h.push(SNAPSHOT_1M);
      h.push(UPDATE_FORMING);
      h.push(UPDATE_ROLLOVER);
      h.push(UPDATE_ROLLOVER);
      h.push(UPDATE_ROLLOVER);

      expect(h.closed()).toEqual([TS_A, TS_B, TS_C]);
      expect(h.closed().filter((ts) => ts === TS_C)).toHaveLength(1);
      expect(h.candles().at(-1)).toEqual({ t: TS_D, c: 64_085.1, closed: false });
    });

    it('un update rezagado de una vela ya cerrada se ignora', () => {
      const h = connected();
      h.push(SNAPSHOT_1M);
      h.push(UPDATE_ROLLOVER);
      const before = h.candles().length;

      h.push(UPDATE_FORMING);

      expect(h.candles()).toHaveLength(before);
      expect(h.closed()).toEqual([TS_A, TS_B, TS_C]);
    });

    it('cierra la vela en formacion por reloj cuando el stream se queda callado', () => {
      let clock = TS_C + 1000;
      const h = connected({ now: () => clock });
      h.push(UPDATE_FORMING);
      expect(h.closed()).toEqual([]);

      clock = TS_C + 59_999;
      h.stream.flushExpired();
      expect(h.closed()).toEqual([]);

      clock = TS_C + 60_000;
      h.stream.flushExpired();
      expect(h.closed()).toEqual([TS_C]);

      h.stream.flushExpired();
      expect(h.closed()).toEqual([TS_C]);
    });

    it('un update tardio de la vela ya cerrada por reloj no la reabre ni la cierra dos veces', () => {
      let clock = TS_C + 1000;
      const h = connected({ now: () => clock });
      h.push(UPDATE_FORMING);

      clock = TS_C + 60_000;
      h.stream.flushExpired();
      expect(h.closed()).toEqual([TS_C]);

      const before = h.candles().length;
      h.push(UPDATE_FORMING);
      expect(h.candles()).toHaveLength(before);

      h.push(UPDATE_ROLLOVER);
      clock = TS_D + 60_000;
      h.stream.flushExpired();

      expect(h.closed()).toEqual([TS_C, TS_D]);
    });

    it('la vela cerrada por reloj no se vuelve a cerrar cuando llega la siguiente', () => {
      let clock = TS_C + 1000;
      const h = connected({ now: () => clock });
      h.push(UPDATE_FORMING);

      clock = TS_D;
      h.stream.flushExpired();
      expect(h.closed()).toEqual([TS_C]);

      h.push(UPDATE_ROLLOVER);
      expect(h.closed()).toEqual([TS_C]);
      expect(h.candles().at(-1)).toEqual({ t: TS_D, c: 64_085.1, closed: false });
    });

    it('cada serie lleva su propio estado', () => {
      const h = connected();
      h.stream.subscribe('ETHUSDT', '1m');
      h.push(UPDATE_FORMING);
      h.push(
        JSON.stringify({
          action: 'update',
          arg: { instType: 'USDT-FUTURES', channel: 'candle1m', instId: 'ETHUSDT' },
          data: [['1786458120000', '3000', '3010', '2990', '3005', '12']],
        }),
      );
      h.push(UPDATE_ROLLOVER);

      expect(
        h.events
          .filter((event) => event.kind === 'candle')
          .map((event) =>
            event.kind === 'candle'
              ? `${event.symbol} ${event.candle.t} ${event.closed ? 'cerrada' : 'formacion'}`
              : '',
          ),
      ).toEqual([
        `BTCUSDT ${TS_C} formacion`,
        `ETHUSDT ${TS_D} formacion`,
        `BTCUSDT ${TS_C} cerrada`,
        `BTCUSDT ${TS_D} formacion`,
      ]);
    });
  });

  describe('mensajes de control', () => {
    it('el rechazo de suscripcion se publica como evento y no tumba el stream', () => {
      const h = connected();
      h.push(EVENT_ERROR);

      expect(h.events.filter((event) => event.kind === 'rejected')).toEqual([
        {
          kind: 'rejected',
          arg: { instType: 'USDT-FUTURES', channel: 'candle1h', instId: 'BTCUSDT' },
          code: '30016',
          message: 'Param error',
        },
      ]);

      h.push(UPDATE_FORMING);
      expect(h.candles()).toEqual([{ t: TS_C, c: 64_103.1, closed: false }]);
      expect(h.stream.socket.state).toBe('open');
    });

    it('la confirmacion de suscripcion se publica con symbol y timeframe', () => {
      const h = connected();
      h.push(EVENT_SUBSCRIBE);

      expect(h.events.filter((event) => event.kind === 'subscribed')).toEqual([
        { kind: 'subscribed', symbol: 'BTCUSDT', timeframe: '1m' },
      ]);
    });

    it('un canal desconocido o un mensaje ilegible se publican como problema de protocolo', () => {
      const h = connected();
      h.push(
        JSON.stringify({
          action: 'update',
          arg: { instType: 'USDT-FUTURES', channel: 'ticker', instId: 'BTCUSDT' },
          data: [],
        }),
      );
      h.push('<html>502 Bad Gateway</html>');

      const problems = h.events.filter((event) => event.kind === 'protocol');
      expect(problems).toHaveLength(2);
      expect(problems[0]).toMatchObject({ detail: 'canal desconocido: ticker' });
      expect(h.candles()).toEqual([]);
      expect(h.stream.socket.state).toBe('open');
    });

    it('un evento de control desconocido se publica como problema de protocolo', () => {
      const h = connected();
      h.push(JSON.stringify({ event: 'login', arg: { instType: 'x', channel: 'y', instId: 'z' } }));

      expect(h.events.filter((event) => event.kind === 'protocol')).toEqual([
        { kind: 'protocol', detail: 'evento de control no manejado: login' },
      ]);
    });

    it('una confirmacion de suscripcion sin canal de velas conocido no se toma por serie', () => {
      const h = connected();
      h.push(JSON.stringify({ event: 'subscribe' }));
      h.push(
        JSON.stringify({
          event: 'subscribe',
          arg: { instType: 'USDT-FUTURES', channel: 'ticker', instId: 'BTCUSDT' },
        }),
      );

      expect(h.events.filter((event) => event.kind === 'subscribed')).toEqual([]);
      expect(h.events.filter((event) => event.kind === 'protocol')).toHaveLength(2);
    });

    it('un rechazo sin code ni mensaje se publica igual, con valores por defecto', () => {
      const h = connected();
      h.push(JSON.stringify({ event: 'error' }));

      expect(h.events.filter((event) => event.kind === 'rejected')).toEqual([
        {
          kind: 'rejected',
          arg: undefined,
          code: 'desconocido',
          message: 'Bitget rechazo la operacion sin mensaje',
        },
      ]);
    });

    it('el pong no llega a los oyentes del stream', () => {
      const h = connected();
      const before = h.events.length;
      h.push(BITGET_WS_PONG);

      expect(h.events).toHaveLength(before);
      expect(h.events.every((event) => event.kind === 'socket')).toBe(true);
    });
  });

  describe('integracion con el socket resiliente', () => {
    it('envia la suscripcion al abrir y la reenvia al reconectar', async () => {
      vi.useFakeTimers();
      try {
        const fakes = createFakeSocketFactory();
        const stream = createBitgetCandleStream({
          url: 'ws://local.test',
          createSocket: fakes.factory,
          staleTimeoutMs: 0,
          heartbeatIntervalMs: 0,
          reconnectBaseMs: 1000,
          random: () => 1,
        });

        stream.subscribe('BTCUSDT', '1m');
        stream.subscribe('BTCUSDT', '1h');
        stream.connect();
        fakes.last().emitOpen();

        const expected = [
          buildSubscribeMessage('BTCUSDT', '1m'),
          buildSubscribeMessage('BTCUSDT', '1h'),
        ];
        expect(fakes.created[0]?.sent).toEqual(expected);

        fakes.last().emitClose();
        await vi.advanceTimersByTimeAsync(1000);
        fakes.last().emitOpen();

        expect(fakes.created[1]?.sent).toEqual(expected);

        await stream.close();
      } finally {
        vi.useRealTimers();
      }
    });

    it('tras reconectar, el snapshot no vuelve a cerrar velas ya cerradas', async () => {
      vi.useFakeTimers();
      try {
        const fakes = createFakeSocketFactory();
        const events: BitgetStreamEvent[] = [];
        const stream = createBitgetCandleStream({
          url: 'ws://local.test',
          createSocket: fakes.factory,
          staleTimeoutMs: 0,
          heartbeatIntervalMs: 0,
          reconnectBaseMs: 1000,
          random: () => 1,
          now: () => 0,
        });
        stream.on((event) => events.push(event));

        stream.subscribe('BTCUSDT', '1m');
        stream.connect();
        fakes.last().emitOpen();
        fakes.last().emitMessage(SNAPSHOT_1M);

        const closedBefore = events
          .filter((event) => event.kind === 'candle' && event.closed)
          .map((event) => (event.kind === 'candle' ? event.candle.t : -1));
        expect(closedBefore).toEqual([TS_A, TS_B]);

        fakes.last().emitClose();
        await vi.advanceTimersByTimeAsync(1000);
        fakes.last().emitOpen();
        fakes.last().emitMessage(SNAPSHOT_1M);

        const closedAfter = events
          .filter((event) => event.kind === 'candle' && event.closed)
          .map((event) => (event.kind === 'candle' ? event.candle.t : -1));
        expect(closedAfter).toEqual([TS_A, TS_B]);

        await stream.close();
      } finally {
        vi.useRealTimers();
      }
    });

    it('los eventos del socket se reenvian a los oyentes del stream', () => {
      const h = harness();
      h.stream.connect();
      h.fakes.last().emitOpen();

      const states = h.events
        .filter((event) => event.kind === 'socket')
        .map((event) => (event.kind === 'socket' ? event.event.kind : ''));

      expect(states).toEqual(['state', 'state']);
    });

    it('unsubscribe manda el mensaje y olvida el estado de la serie', () => {
      const h = connected();
      h.push(UPDATE_FORMING);

      h.stream.unsubscribe('BTCUSDT', '1m');
      expect(h.fakes.last().sent.at(-1)).toBe(buildUnsubscribeMessage('BTCUSDT', '1m'));
      expect(h.stream.socket.subscriptionIds).toEqual([]);

      h.push(UPDATE_ROLLOVER);
      expect(h.closed()).toEqual([]);
    });
  });

  describe('sin red real', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('el stream no abre ninguna conexion de salida con la factoria falsa', () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const h = connected();
      h.push(SNAPSHOT_1M);

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(h.fakes.created).toHaveLength(1);
      expect(h.fakes.created[0]?.url).toBe('ws://local.test');
    });

    it('todos los timeframes del dominio tienen canal, ninguno cae en el default de Bitget', () => {
      const channels = TIMEFRAMES.map((timeframe: Timeframe) => toCandleChannel(timeframe));
      expect(new Set(channels).size).toBe(TIMEFRAMES.length);
    });
  });
});
