export interface RateLimiterOptions {
  rps: number;
}

export interface RateLimiter {
  readonly intervalMs: number;
  acquire(): Promise<void>;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function createRateLimiter({ rps }: RateLimiterOptions): RateLimiter {
  if (!Number.isFinite(rps) || rps <= 0) {
    throw new RangeError(`rps debe ser un numero positivo y finito, recibido: ${rps}`);
  }

  const intervalMs = 1000 / rps;
  let nextAt = Number.NEGATIVE_INFINITY;

  return {
    intervalMs,
    async acquire(): Promise<void> {
      const now = Date.now();
      const grantAt = Math.max(now, nextAt);
      nextAt = grantAt + intervalMs;

      const wait = grantAt - now;
      if (wait > 0) await sleep(wait);
    },
  };
}
