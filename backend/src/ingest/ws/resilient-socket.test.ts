import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createResilientSocket,
  rawDataToString,
  type ResilientSocketEvent,
  type SocketFactory,
  type SocketHandlers,
  type SocketLike,
} from './resilient-socket.js';

const ADAPTER_LISTENERS = 4;

interface FakeSocket extends SocketLike {
  readonly url: string;
  readonly sent: string[];
  readonly terminated: boolean;
  readonly closeCalls: number;
  emitOpen(): void;
  emitMessage(data: string): void;
  emitError(error: Error): void;
  emitClose(code?: number, reason?: string): void;
}

interface FakeFactory {
  readonly factory: SocketFactory;
  readonly created: FakeSocket[];
  last(): FakeSocket;
}

function createFakeFactory(options: { closeOnRequest?: boolean } = {}): FakeFactory {
  const closeOnRequest = options.closeOnRequest ?? true;
  const created: FakeSocket[] = [];

  const factory: SocketFactory = (url, handlers: SocketHandlers) => {
    let live = true;
    let listeners = ADAPTER_LISTENERS;
    let terminated = false;
    let closeCalls = 0;
    const sent: string[] = [];

    const fake: FakeSocket = {
      url,
      sent,
      get terminated() {
        return terminated;
      },
      get closeCalls() {
        return closeCalls;
      },
      get listenerCount() {
        return listeners;
      },
      send(message) {
        sent.push(message);
      },
      close() {
        closeCalls += 1;
        if (closeOnRequest) fake.emitClose(1000, 'normal');
      },
      terminate() {
        terminated = true;
      },
      dispose() {
        live = false;
        listeners = 0;
      },
      emitOpen() {
        if (live) handlers.open();
      },
      emitMessage(data) {
        if (live) handlers.message(data);
      },
      emitError(error) {
        if (live) handlers.error(error);
      },
      emitClose(code = 1006, reason = '') {
        if (!live) return;
        live = false;
        handlers.close(code, reason);
      },
    };

    created.push(fake);
    return fake;
  };

  return {
    factory,
    created,
    last() {
      const socket = created.at(-1);
      if (socket === undefined) throw new Error('no se ha creado ningun socket');
      return socket;
    },
  };
}

function kinds(events: readonly ResilientSocketEvent[], kind: ResilientSocketEvent['kind']) {
  return events.filter((event) => event.kind === kind);
}

describe('createResilientSocket', () => {
  describe('validacion de opciones', () => {
    it('rechaza tiempos no positivos y un maximo por debajo de la base', () => {
      const url = 'ws://local.test';
      expect(() => createResilientSocket({ url, reconnectBaseMs: 0 })).toThrow(RangeError);
      expect(() => createResilientSocket({ url, staleTimeoutMs: -1 })).toThrow(RangeError);
      expect(() => createResilientSocket({ url, heartbeatIntervalMs: Number.NaN })).toThrow(
        RangeError,
      );
      expect(() =>
        createResilientSocket({ url, reconnectBaseMs: 5000, reconnectMaxMs: 1000 }),
      ).toThrow(RangeError);
    });
  });

  describe('con reloj falso', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('recorre idle -> connecting -> open y publica cada transicion', () => {
      const fakes = createFakeFactory();
      const events: ResilientSocketEvent[] = [];
      const socket = createResilientSocket({
        url: 'ws://local.test',
        createSocket: fakes.factory,
      });
      socket.on((event) => events.push(event));

      expect(socket.state).toBe('idle');

      socket.connect();
      expect(socket.state).toBe('connecting');

      fakes.last().emitOpen();
      expect(socket.state).toBe('open');

      expect(kinds(events, 'state')).toEqual([
        { kind: 'state', from: 'idle', to: 'connecting' },
        { kind: 'state', from: 'connecting', to: 'open' },
      ]);
    });

    it('escala el backoff de forma exponencial hasta el techo', async () => {
      const fakes = createFakeFactory();
      const events: ResilientSocketEvent[] = [];
      const socket = createResilientSocket({
        url: 'ws://local.test',
        reconnectBaseMs: 1000,
        reconnectMaxMs: 30_000,
        staleTimeoutMs: 0,
        heartbeatIntervalMs: 0,
        random: () => 1,
        createSocket: fakes.factory,
      });
      socket.on((event) => events.push(event));

      socket.connect();

      for (let cycle = 0; cycle < 7; cycle += 1) {
        fakes.last().emitClose();
        await vi.advanceTimersByTimeAsync(30_000);
      }

      const delays = kinds(events, 'reconnect').map((event) =>
        event.kind === 'reconnect' ? event.delayMs : -1,
      );
      expect(delays).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]);

      await socket.close();
    });

    it('mantiene el jitter dentro de [0, techo] y no siempre en el techo', async () => {
      const fakes = createFakeFactory();
      const events: ResilientSocketEvent[] = [];
      const draws = [0, 0.25, 0.5, 0.75, 1];
      let index = 0;

      const socket = createResilientSocket({
        url: 'ws://local.test',
        reconnectBaseMs: 1000,
        reconnectMaxMs: 30_000,
        staleTimeoutMs: 0,
        heartbeatIntervalMs: 0,
        random: () => draws[index++ % draws.length] ?? 0,
        createSocket: fakes.factory,
      });
      socket.on((event) => events.push(event));

      socket.connect();

      for (let cycle = 0; cycle < 5; cycle += 1) {
        fakes.last().emitClose();
        await vi.advanceTimersByTimeAsync(30_000);
      }

      const delays = kinds(events, 'reconnect').map((event) =>
        event.kind === 'reconnect' ? event.delayMs : -1,
      );
      const ceilings = [1000, 2000, 4000, 8000, 16_000];

      expect(delays).toEqual([0, 500, 2000, 6000, 16_000]);
      for (const [i, delay] of delays.entries()) {
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(ceilings[i] ?? 0);
      }
      expect(new Set(delays).size).toBeGreaterThan(1);

      await socket.close();
    });

    it('resetea el contador de intentos tras N segundos estable', async () => {
      const fakes = createFakeFactory();
      const socket = createResilientSocket({
        url: 'ws://local.test',
        reconnectBaseMs: 1000,
        staleTimeoutMs: 0,
        heartbeatIntervalMs: 0,
        stableResetMs: 60_000,
        random: () => 1,
        createSocket: fakes.factory,
      });

      socket.connect();
      fakes.last().emitOpen();
      fakes.last().emitClose();
      await vi.advanceTimersByTimeAsync(1000);
      fakes.last().emitOpen();
      fakes.last().emitClose();
      await vi.advanceTimersByTimeAsync(2000);
      expect(socket.reconnectAttempts).toBe(2);

      fakes.last().emitOpen();
      await vi.advanceTimersByTimeAsync(59_999);
      expect(socket.reconnectAttempts).toBe(2);

      await vi.advanceTimersByTimeAsync(1);
      expect(socket.reconnectAttempts).toBe(0);

      await socket.close();
    });

    it('el watchdog detecta un socket que acepta pero no emite y reconecta', async () => {
      const fakes = createFakeFactory();
      const events: ResilientSocketEvent[] = [];
      const socket = createResilientSocket({
        url: 'ws://local.test',
        staleTimeoutMs: 45_000,
        heartbeatIntervalMs: 0,
        reconnectBaseMs: 1000,
        random: () => 0,
        createSocket: fakes.factory,
      });
      socket.on((event) => events.push(event));

      socket.connect();
      const zombie = fakes.last();
      zombie.emitOpen();

      await vi.advanceTimersByTimeAsync(44_999);
      expect(kinds(events, 'stale')).toHaveLength(0);
      expect(zombie.terminated).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(kinds(events, 'stale')).toEqual([{ kind: 'stale', idleMs: 45_000 }]);
      expect(zombie.terminated).toBe(true);

      await vi.advanceTimersByTimeAsync(1000);
      expect(fakes.created).toHaveLength(2);
      expect(socket.state).toBe('connecting');

      await socket.close();
    });

    it('cada mensaje rearma el watchdog', async () => {
      const fakes = createFakeFactory();
      const events: ResilientSocketEvent[] = [];
      const socket = createResilientSocket({
        url: 'ws://local.test',
        staleTimeoutMs: 45_000,
        heartbeatIntervalMs: 0,
        createSocket: fakes.factory,
      });
      socket.on((event) => events.push(event));

      socket.connect();
      fakes.last().emitOpen();

      for (let tick = 0; tick < 10; tick += 1) {
        await vi.advanceTimersByTimeAsync(30_000);
        fakes.last().emitMessage('{"data":1}');
      }

      expect(kinds(events, 'stale')).toHaveLength(0);
      expect(fakes.created).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(45_000);
      expect(kinds(events, 'stale')).toHaveLength(1);

      await socket.close();
    });

    it('envia el ping de aplicacion y consume el pong sin publicarlo', async () => {
      const fakes = createFakeFactory();
      const events: ResilientSocketEvent[] = [];
      const socket = createResilientSocket({
        url: 'ws://local.test',
        heartbeatIntervalMs: 20_000,
        staleTimeoutMs: 45_000,
        createSocket: fakes.factory,
      });
      socket.on((event) => events.push(event));

      socket.connect();
      const live = fakes.last();
      live.emitOpen();

      await vi.advanceTimersByTimeAsync(20_000);
      live.emitMessage('pong');
      await vi.advanceTimersByTimeAsync(20_000);
      live.emitMessage('pong');

      expect(live.sent).toEqual(['ping', 'ping']);
      expect(kinds(events, 'message')).toHaveLength(0);
      expect(kinds(events, 'stale')).toHaveLength(0);

      live.emitMessage('{"action":"update"}');
      expect(kinds(events, 'message')).toEqual([{ kind: 'message', data: '{"action":"update"}' }]);

      await socket.close();
    });

    it('tras 5 reconexiones procesa un mensaje una sola vez', async () => {
      const fakes = createFakeFactory();
      const received: string[] = [];
      const socket = createResilientSocket({
        url: 'ws://local.test',
        reconnectBaseMs: 1000,
        staleTimeoutMs: 0,
        heartbeatIntervalMs: 0,
        random: () => 1,
        createSocket: fakes.factory,
      });
      socket.on((event) => {
        if (event.kind === 'message') received.push(event.data);
      });

      socket.connect();
      fakes.last().emitOpen();

      for (let cycle = 0; cycle < 5; cycle += 1) {
        fakes.last().emitClose();
        await vi.advanceTimersByTimeAsync(30_000);
        fakes.last().emitOpen();
      }

      expect(fakes.created).toHaveLength(6);

      fakes.last().emitMessage('{"vela":1}');

      expect(received).toEqual(['{"vela":1}']);
    });

    it('reenvia todas las suscripciones al reconectar, sin duplicarlas', async () => {
      const fakes = createFakeFactory();
      const socket = createResilientSocket({
        url: 'ws://local.test',
        reconnectBaseMs: 1000,
        staleTimeoutMs: 0,
        heartbeatIntervalMs: 0,
        random: () => 1,
        createSocket: fakes.factory,
      });

      socket.subscribe('btc-1m', '{"op":"subscribe","arg":"candle1m:BTCUSDT"}');
      socket.subscribe('eth-1m', '{"op":"subscribe","arg":"candle1m:ETHUSDT"}');
      socket.subscribe('btc-1m', '{"op":"subscribe","arg":"candle1m:BTCUSDT"}');

      expect(socket.subscriptionIds).toEqual(['btc-1m', 'eth-1m']);

      socket.connect();
      fakes.last().emitOpen();
      expect(fakes.created[0]?.sent).toEqual([
        '{"op":"subscribe","arg":"candle1m:BTCUSDT"}',
        '{"op":"subscribe","arg":"candle1m:ETHUSDT"}',
      ]);

      fakes.last().emitClose();
      await vi.advanceTimersByTimeAsync(1000);
      fakes.last().emitOpen();

      expect(fakes.created[1]?.sent).toEqual([
        '{"op":"subscribe","arg":"candle1m:BTCUSDT"}',
        '{"op":"subscribe","arg":"candle1m:ETHUSDT"}',
      ]);

      socket.unsubscribe('eth-1m', '{"op":"unsubscribe","arg":"candle1m:ETHUSDT"}');
      fakes.last().emitClose();
      await vi.advanceTimersByTimeAsync(2000);
      fakes.last().emitOpen();

      expect(socket.subscriptionIds).toEqual(['btc-1m']);
      expect(fakes.created[2]?.sent).toEqual(['{"op":"subscribe","arg":"candle1m:BTCUSDT"}']);

      await socket.close();
    });

    it('close() no reconecta y deja 0 timers y 0 listeners', async () => {
      const fakes = createFakeFactory();
      const socket = createResilientSocket({
        url: 'ws://local.test',
        reconnectBaseMs: 1000,
        staleTimeoutMs: 45_000,
        heartbeatIntervalMs: 20_000,
        createSocket: fakes.factory,
      });

      socket.connect();
      const live = fakes.last();
      live.emitOpen();
      socket.subscribe('btc-1m', '{"op":"subscribe"}');

      expect(vi.getTimerCount()).toBeGreaterThan(0);
      expect(live.listenerCount).toBe(ADAPTER_LISTENERS);

      await socket.close();

      expect(socket.state).toBe('closed');
      expect(live.closeCalls).toBe(1);
      expect(live.listenerCount).toBe(0);
      expect(vi.getTimerCount()).toBe(0);

      await vi.advanceTimersByTimeAsync(120_000);
      expect(fakes.created).toHaveLength(1);
      expect(socket.state).toBe('closed');
      expect(vi.getTimerCount()).toBe(0);
    });

    it('close() sobre un socket que no responde termina por el periodo de gracia', async () => {
      const fakes = createFakeFactory({ closeOnRequest: false });
      const socket = createResilientSocket({
        url: 'ws://local.test',
        closeGraceMs: 1000,
        staleTimeoutMs: 0,
        heartbeatIntervalMs: 0,
        createSocket: fakes.factory,
      });

      socket.connect();
      const stuck = fakes.last();
      stuck.emitOpen();

      const closing = socket.close();
      expect(socket.state).toBe('closing');

      await vi.advanceTimersByTimeAsync(1000);
      await closing;

      expect(stuck.terminated).toBe(true);
      expect(socket.state).toBe('closed');
      expect(vi.getTimerCount()).toBe(0);
    });

    it('un fallo al crear el socket se publica y reprograma la conexion', async () => {
      const events: ResilientSocketEvent[] = [];
      let calls = 0;
      const socket = createResilientSocket({
        url: 'ws://local.test',
        reconnectBaseMs: 1000,
        random: () => 1,
        createSocket: () => {
          calls += 1;
          throw new Error('ENOTFOUND local.test');
        },
      });
      socket.on((event) => events.push(event));

      socket.connect();
      expect(calls).toBe(1);
      expect(kinds(events, 'error')).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1000);
      expect(calls).toBe(2);

      await socket.close();
    });
  });

  describe('contra un servidor WebSocket local', () => {
    let server: WebSocketServer;
    let url: string;

    beforeEach(async () => {
      server = new WebSocketServer({ port: 0 });
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('se esperaba un puerto TCP');
      }
      url = `ws://127.0.0.1:${address.port}`;
    });

    afterEach(async () => {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    });

    it('cortar el socket desde el servidor: reconecta y reenvia las suscripciones', async () => {
      const subscribeMessage = '{"op":"subscribe","arg":"candle1m:BTCUSDT"}';
      const connections: ServerSocket[] = [];
      const received: string[] = [];
      let resolveSecond: (() => void) | undefined;
      const secondSubscription = new Promise<void>((resolve) => {
        resolveSecond = resolve;
      });

      server.on('connection', (client) => {
        connections.push(client);
        client.on('message', (data) => {
          received.push(rawDataToString(data));
          if (received.length === 2) resolveSecond?.();
        });
      });

      const socket = createResilientSocket({
        url,
        reconnectBaseMs: 10,
        reconnectMaxMs: 50,
        staleTimeoutMs: 0,
        heartbeatIntervalMs: 0,
        random: () => 1,
      });

      const reconnects: number[] = [];
      socket.on((event) => {
        if (event.kind === 'reconnect') reconnects.push(event.attempt);
      });

      socket.subscribe('btc-1m', subscribeMessage);
      socket.connect();

      await vi.waitFor(() => {
        expect(received).toEqual([subscribeMessage]);
      });
      expect(socket.state).toBe('open');

      connections[0]?.terminate();

      await secondSubscription;

      expect(connections).toHaveLength(2);
      expect(received).toEqual([subscribeMessage, subscribeMessage]);
      expect(reconnects).toEqual([1]);
      expect(socket.state).toBe('open');

      await socket.close();
      expect(socket.state).toBe('closed');
    });

    it('close() sobre una conexion real deja el socket cerrado y sin listeners', async () => {
      const socket = createResilientSocket({
        url,
        staleTimeoutMs: 0,
        heartbeatIntervalMs: 0,
      });

      socket.connect();
      await vi.waitFor(() => {
        expect(socket.state).toBe('open');
      });

      await socket.close();

      expect(socket.state).toBe('closed');
      await vi.waitFor(() => {
        expect(server.clients.size).toBe(0);
      });
    });
  });
});
