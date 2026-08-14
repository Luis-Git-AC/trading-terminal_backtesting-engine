import { describe, expect, it, vi } from 'vitest';
import { TimeoutError, waitFor } from './wait.js';

function fakeClock(): { now: () => number; wait: (ms: number) => Promise<void> } {
  let current = 0;
  return {
    now: () => current,
    wait: (ms: number) => {
      current += ms;
      return Promise.resolve();
    },
  };
}

describe('waitFor', () => {
  it('devuelve el primer valor definido sin esperar de mas', async () => {
    const clock = fakeClock();
    const result = await waitFor(() => Promise.resolve('listo'), {
      label: 'algo',
      timeoutMs: 1000,
      ...clock,
    });

    expect(result.value).toBe('listo');
    expect(result.attempts).toBe(1);
    expect(result.elapsedMs).toBe(0);
  });

  it('reintenta mientras el intento devuelve undefined', async () => {
    const clock = fakeClock();
    const attempt = vi
      .fn<() => Promise<string | undefined>>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue('listo');

    const result = await waitFor(attempt, {
      label: 'algo',
      timeoutMs: 10_000,
      intervalMs: 100,
      ...clock,
    });

    expect(result.attempts).toBe(3);
    expect(result.elapsedMs).toBe(200);
  });

  it('reintenta cuando el intento lanza', async () => {
    const clock = fakeClock();
    const attempt = vi
      .fn<() => Promise<boolean | undefined>>()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue(true);

    await expect(
      waitFor(attempt, { label: 'la base de datos', timeoutMs: 5000, intervalMs: 50, ...clock }),
    ).resolves.toMatchObject({ attempts: 2 });
  });

  it('lanza TimeoutError con la ultima causa cuando se agota el plazo', async () => {
    const clock = fakeClock();
    const attempt = vi
      .fn<() => Promise<boolean | undefined>>()
      .mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:55432'));

    await expect(
      waitFor(attempt, { label: 'la base de datos', timeoutMs: 300, intervalMs: 100, ...clock }),
    ).rejects.toThrow(TimeoutError);

    await expect(
      waitFor(attempt, { label: 'la base de datos', timeoutMs: 300, intervalMs: 100, ...clock }),
    ).rejects.toThrow(
      /la base de datos no estuvo listo en 300 ms .*ECONNREFUSED 127\.0\.0\.1:55432/,
    );
  });

  it('trata false y 0 como valores validos, solo undefined reintenta', async () => {
    const clock = fakeClock();

    await expect(
      waitFor(() => Promise.resolve(false), { label: 'x', timeoutMs: 100, ...clock }),
    ).resolves.toMatchObject({ value: false, attempts: 1 });

    await expect(
      waitFor(() => Promise.resolve(0), { label: 'x', timeoutMs: 100, ...clock }),
    ).resolves.toMatchObject({ value: 0, attempts: 1 });
  });

  it('hace al menos un intento aunque el plazo sea cero', async () => {
    const clock = fakeClock();
    const attempt = vi.fn<() => Promise<boolean | undefined>>().mockResolvedValue(undefined);

    await expect(waitFor(attempt, { label: 'x', timeoutMs: 0, ...clock })).rejects.toThrow(
      TimeoutError,
    );
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});
