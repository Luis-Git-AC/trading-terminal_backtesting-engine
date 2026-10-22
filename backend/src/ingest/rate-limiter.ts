export interface RateLimiterOptions {
  rps: number;
}

export interface RateLimiter {
  readonly intervalMs: number;
  acquire(): Promise<void>;
  /** Retrasa el siguiente permiso: para frenar antes de un 429 cuando el exchange avisa del peso usado. */
  pause(ms: number): void;
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

    pause(ms: number): void {
      if (!Number.isFinite(ms) || ms <= 0) return;
      nextAt = Math.max(nextAt, Date.now() + ms);
    },

    async acquire(): Promise<void> {
      const now = Date.now();
      const grantAt = Math.max(now, nextAt);
      nextAt = grantAt + intervalMs;

      const wait = grantAt - now;
      if (wait > 0) await sleep(wait);
    },
  };
}
