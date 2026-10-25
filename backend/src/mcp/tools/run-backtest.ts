import { createBacktestBodySchema, type CreateBacktestResponse } from '@tt/shared';
import { AppError } from '../../api/errors.js';
import {
  DEFAULT_MAX_CREATE,
  DEFAULT_WINDOW_MS,
  backtestRateLimitMessage,
  type RateLimitOptions,
} from '../../api/middleware/rate-limit.js';
import { createBacktest } from '../../api/services/backtests.service.js';
import type { McpToolDeps } from './deps.js';

export function createRunRateLimiter(options: RateLimitOptions, now: () => number): () => void {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const max = options.max ?? DEFAULT_MAX_CREATE;
  let windowStart = Number.NEGATIVE_INFINITY;
  let used = 0;

  return () => {
    const t = now();
    if (t - windowStart >= windowMs) {
      windowStart = t;
      used = 0;
    }
    if (used >= max) throw AppError.rateLimited(backtestRateLimitMessage(max, windowMs));
    used += 1;
  };
}

export async function runBacktestTool(
  deps: McpToolDeps,
  input: unknown,
): Promise<CreateBacktestResponse> {
  if (deps.backtests === undefined) {
    throw new Error(
      'El backtesting no esta configurado en este proceso: falta la conexion a Redis',
    );
  }
  deps.backtests.takeSlot();
  return createBacktest(deps.backtests.service, createBacktestBodySchema.parse(input));
}
