import { sourceStateKey } from '@tt/shared';
import { describe, expect, it } from 'vitest';
import { createSourceStateStore, toSourceHealth, type RedisLike } from './state.js';

function fakeRedis(seed: Record<string, Record<string, string>> = {}): RedisLike & {
  readonly store: Record<string, Record<string, string>>;
} {
  const store: Record<string, Record<string, string>> = { ...seed };

  return {
    store,
    hset(key, values) {
      store[key] = { ...store[key], ...values };
      return Promise.resolve(1);
    },
    hgetall(key) {
      return Promise.resolve(store[key] ?? {});
    },
  };
}

describe('toSourceHealth', () => {
  it('sin ninguna ejecucion queda pendiente', () => {
    expect(toSourceHealth('x', {})).toEqual({
      id: 'x',
      state: 'pending',
      lastOkAt: null,
      lastErrorAt: null,
      lastError: null,
      items: null,
    });
  });

  it('un error posterior al ultimo ok degrada la fuente', () => {
    const health = toSourceHealth('x', {
      lastOkAt: '1000',
      lastErrorAt: '2000',
      lastError: 'timeout',
      items: '5',
    });

    expect(health).toMatchObject({ state: 'error', lastError: 'timeout', items: 5 });
  });

  it('un ok posterior al ultimo error la recupera, y el error antiguo sigue visible', () => {
    const health = toSourceHealth('x', {
      lastOkAt: '3000',
      lastErrorAt: '2000',
      lastError: 'timeout',
    });

    expect(health).toMatchObject({ state: 'ok', lastErrorAt: 2000, lastError: 'timeout' });
  });

  it('un valor no numerico se lee como ausente, no como cero', () => {
    expect(toSourceHealth('x', { lastOkAt: 'ayer', items: '' })).toMatchObject({
      state: 'pending',
      lastOkAt: null,
      items: null,
    });
  });
});

describe('createSourceStateStore', () => {
  it('escribe el ok con su marca y el numero de elementos', async () => {
    const redis = fakeRedis();
    const store = createSourceStateStore(redis);

    await store.recordOk('fred', 1_700, 42);

    expect(redis.store[sourceStateKey('fred')]).toEqual({ lastOkAt: '1700', items: '42' });
  });

  it('el error no borra el ultimo ok: los dos conviven', async () => {
    const redis = fakeRedis();
    const store = createSourceStateStore(redis);

    await store.recordOk('fred', 1_000, 1);
    await store.recordError('fred', 2_000, 'se cayo');

    expect(redis.store[sourceStateKey('fred')]).toMatchObject({
      lastOkAt: '1000',
      lastErrorAt: '2000',
      lastError: 'se cayo',
    });
  });

  it('recorta el mensaje de error para que no engorde la clave', async () => {
    const redis = fakeRedis();
    await createSourceStateStore(redis).recordError('fred', 1, 'x'.repeat(2_000));

    expect(redis.store[sourceStateKey('fred')]?.lastError).toHaveLength(500);
  });

  it('una sola fuente en error degrada el conjunto', async () => {
    const redis = fakeRedis({
      [sourceStateKey('a')]: { lastOkAt: '1' },
      [sourceStateKey('b')]: { lastErrorAt: '2', lastError: 'boom' },
    });

    const health = await createSourceStateStore(redis).read(['a', 'b']);

    expect(health.status).toBe('degraded');
    expect(health.sources.map((item) => item.state)).toEqual(['ok', 'error']);
  });

  it('las fuentes pendientes no degradan nada', async () => {
    const health = await createSourceStateStore(fakeRedis()).read(['a', 'b']);

    expect(health.status).toBe('ok');
    expect(health.sources.map((item) => item.state)).toEqual(['pending', 'pending']);
  });
});
