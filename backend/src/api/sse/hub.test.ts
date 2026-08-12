import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../observability/logger.js';
import { createSseHub, type SubscriberLike } from './hub.js';

const logger = createLogger({ role: 'api', level: 'silent' });

interface FakeSubscriber extends SubscriberLike {
  readonly subscribed: string[];
  readonly unsubscribed: string[];
  emit(channel: string, message: string): void;
}

function fakeSubscriber(overrides: Partial<SubscriberLike> = {}): FakeSubscriber {
  const subscribed: string[] = [];
  const unsubscribed: string[] = [];
  let handler: ((channel: string, message: string) => void) | null = null;

  return {
    subscribed,
    unsubscribed,
    subscribe(channel: string) {
      subscribed.push(channel);
      return Promise.resolve(1);
    },
    unsubscribe(channel: string) {
      unsubscribed.push(channel);
      return Promise.resolve(0);
    },
    on(_event: 'message', listener: (channel: string, message: string) => void) {
      handler = listener;
      return this;
    },
    emit(channel: string, message: string) {
      handler?.(channel, message);
    },
    ...overrides,
  };
}

describe('createSseHub', () => {
  it('se suscribe a Redis la primera vez y reparte los mensajes del canal', async () => {
    const subscriber = fakeSubscriber();
    const hub = createSseHub({ subscriber, logger });
    const received: string[] = [];

    await hub.subscribe('ch:run:a', (message) => received.push(message));
    subscriber.emit('ch:run:a', 'hola');

    expect(subscriber.subscribed).toEqual(['ch:run:a']);
    expect(received).toEqual(['hola']);
  });

  it('50 clientes sobre el mismo canal producen una unica suscripcion Redis', async () => {
    const subscriber = fakeSubscriber();
    const hub = createSseHub({ subscriber, logger });
    const counters = Array.from({ length: 50 }, () => vi.fn());

    for (const counter of counters) {
      await hub.subscribe('ch:run:a', counter);
    }
    subscriber.emit('ch:run:a', 'tick');

    expect(subscriber.subscribed).toEqual(['ch:run:a']);
    expect(hub.listenerCount('ch:run:a')).toBe(50);
    expect(hub.channels()).toEqual(['ch:run:a']);
    for (const counter of counters) {
      expect(counter).toHaveBeenCalledExactlyOnceWith('tick');
    }
  });

  it('solo se desuscribe cuando se va el ultimo cliente', async () => {
    const subscriber = fakeSubscriber();
    const hub = createSseHub({ subscriber, logger });

    const first = await hub.subscribe('ch:run:a', vi.fn());
    const second = await hub.subscribe('ch:run:a', vi.fn());

    await first();
    expect(subscriber.unsubscribed).toEqual([]);
    expect(hub.listenerCount('ch:run:a')).toBe(1);

    await second();
    expect(subscriber.unsubscribed).toEqual(['ch:run:a']);
    expect(hub.listenerCount('ch:run:a')).toBe(0);
    expect(hub.channels()).toEqual([]);
  });

  it('soltar dos veces el mismo cliente no desuscribe a los demas', async () => {
    const subscriber = fakeSubscriber();
    const hub = createSseHub({ subscriber, logger });
    const survivor = vi.fn();

    const release = await hub.subscribe('ch:run:a', vi.fn());
    await hub.subscribe('ch:run:a', survivor);

    await release();
    await release();

    expect(subscriber.unsubscribed).toEqual([]);
    expect(hub.listenerCount('ch:run:a')).toBe(1);
    subscriber.emit('ch:run:a', 'sigo aqui');
    expect(survivor).toHaveBeenCalledExactlyOnceWith('sigo aqui');
  });

  it('canales distintos se multiplexan sobre la misma conexion', async () => {
    const subscriber = fakeSubscriber();
    const hub = createSseHub({ subscriber, logger });
    const run = vi.fn();
    const candles = vi.fn();

    await hub.subscribe('ch:run:a', run);
    await hub.subscribe('ch:candles:BTCUSDT:1m', candles);
    subscriber.emit('ch:candles:BTCUSDT:1m', 'vela');

    expect(subscriber.subscribed).toEqual(['ch:run:a', 'ch:candles:BTCUSDT:1m']);
    expect(candles).toHaveBeenCalledExactlyOnceWith('vela');
    expect(run).not.toHaveBeenCalled();
  });

  it('un mensaje de un canal sin oyentes no revienta', () => {
    const subscriber = fakeSubscriber();
    createSseHub({ subscriber, logger });

    expect(() => subscriber.emit('ch:run:fantasma', 'nadie escucha')).not.toThrow();
  });

  it('si un oyente lanza, el resto sigue recibiendo', async () => {
    const subscriber = fakeSubscriber();
    const hub = createSseHub({ subscriber, logger });
    const healthy = vi.fn();

    await hub.subscribe('ch:run:a', () => {
      throw new Error('cliente roto');
    });
    await hub.subscribe('ch:run:a', healthy);

    expect(() => subscriber.emit('ch:run:a', 'tick')).not.toThrow();
    expect(healthy).toHaveBeenCalledExactlyOnceWith('tick');
  });

  it('un fallo al suscribirse no deja el canal registrado', async () => {
    const subscriber = fakeSubscriber({
      subscribe: () => Promise.reject(new Error('redis caido')),
    });
    const hub = createSseHub({ subscriber, logger });

    await expect(hub.subscribe('ch:run:a', vi.fn())).rejects.toThrow('redis caido');
    expect(hub.channels()).toEqual([]);
    expect(hub.listenerCount('ch:run:a')).toBe(0);
  });

  it('un fallo al desuscribirse no propaga al llamante', async () => {
    const subscriber = fakeSubscriber({
      unsubscribe: () => Promise.reject(new Error('redis caido')),
    });
    const hub = createSseHub({ subscriber, logger });

    const release = await hub.subscribe('ch:run:a', vi.fn());

    await expect(release()).resolves.toBeUndefined();
    expect(hub.channels()).toEqual([]);
  });
});
