export const POLL_INTERVAL_MS = 500;

export class TimeoutError extends Error {
  override readonly name: string = 'TimeoutError';
}

export interface WaitForOptions {
  readonly label: string;
  readonly timeoutMs: number;
  readonly intervalMs?: number;
  readonly now?: () => number;
  readonly wait?: (ms: number) => Promise<void>;
}

export interface WaitForResult<T> {
  readonly value: T;
  readonly elapsedMs: number;
  readonly attempts: number;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor<T>(
  attempt: () => Promise<T | undefined>,
  options: WaitForOptions,
): Promise<WaitForResult<T>> {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? sleep;
  const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS;
  const startedAt = now();

  let attempts = 0;
  let lastError: unknown;

  for (;;) {
    attempts += 1;

    try {
      const value = await attempt();
      if (value !== undefined) {
        return { value, elapsedMs: now() - startedAt, attempts };
      }
    } catch (error) {
      lastError = error;
    }

    if (now() - startedAt >= options.timeoutMs) {
      const cause = lastError instanceof Error ? `: ${lastError.message}` : '';
      throw new TimeoutError(
        `${options.label} no estuvo listo en ${options.timeoutMs} ms (${attempts} intento(s))${cause}`,
      );
    }

    await wait(intervalMs);
  }
}
