import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRateLimiter } from './rate-limiter.js';

describe('createRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('deriva el intervalo de rps', () => {
    expect(createRateLimiter({ rps: 5 }).intervalMs).toBe(200);
    expect(createRateLimiter({ rps: 2 }).intervalMs).toBe(500);
    expect(createRateLimiter({ rps: 0.5 }).intervalMs).toBe(2000);
  });

  it('rechaza un rps que no es un numero positivo y finito', () => {
    expect(() => createRateLimiter({ rps: 0 })).toThrow(RangeError);
    expect(() => createRateLimiter({ rps: -1 })).toThrow(RangeError);
    expect(() => createRateLimiter({ rps: Number.POSITIVE_INFINITY })).toThrow(RangeError);
    expect(() => createRateLimiter({ rps: Number.NaN })).toThrow(RangeError);
  });

  it('reparte 5 permisos pedidos a la vez a 5 rps sin rafaga inicial', async () => {
    const limiter = createRateLimiter({ rps: 5 });
    const start = Date.now();
    const grants: number[] = [];

    const tasks = Array.from({ length: 5 }, () =>
      limiter.acquire().then(() => {
        grants.push(Date.now() - start);
      }),
    );

    await vi.advanceTimersByTimeAsync(2000);
    await Promise.all(tasks);

    expect(grants).toEqual([0, 200, 400, 600, 800]);
  });

  it('nunca concede mas de rps permisos en ninguna ventana de un segundo', async () => {
    const limiter = createRateLimiter({ rps: 5 });
    const start = Date.now();
    const grants: number[] = [];

    const tasks = Array.from({ length: 20 }, () =>
      limiter.acquire().then(() => {
        grants.push(Date.now() - start);
      }),
    );

    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all(tasks);

    expect(grants).toHaveLength(20);
    for (const [index, at] of grants.entries()) {
      const inWindow = grants.filter((other) => other >= at && other < at + 1000).length;
      expect({ index, inWindow }).toEqual({ index, inWindow: Math.min(5, 20 - index) });
    }
  });

  it('no acumula deuda: tras un rato parado, el siguiente permiso es inmediato', async () => {
    const limiter = createRateLimiter({ rps: 5 });

    await limiter.acquire();
    await vi.advanceTimersByTimeAsync(5000);

    const start = Date.now();
    let grantedAt: number | undefined;
    const task = limiter.acquire().then(() => {
      grantedAt = Date.now() - start;
    });

    await vi.advanceTimersByTimeAsync(0);
    await task;

    expect(grantedAt).toBe(0);
  });
});
