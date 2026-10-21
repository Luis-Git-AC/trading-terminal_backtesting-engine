import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import type { Request, RequestHandler } from 'express';
import { AppError } from '../errors.js';

export const DEFAULT_WINDOW_MS = 60_000;

export const DEFAULT_MAX_CREATE = 60;

export interface RateLimitOptions {
  readonly windowMs?: number;
  readonly max?: number;
}

export function createBacktestRateLimit(options: RateLimitOptions = {}): RequestHandler {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const max = options.max ?? DEFAULT_MAX_CREATE;

  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (req: Request) => ipKeyGenerator(req.ip ?? 'unknown'),
    handler: (_req, _res, next) => {
      next(
        AppError.rateLimited(
          `Demasiados backtests encolados: el maximo es ${max} cada ${Math.round(windowMs / 1000)} s`,
        ),
      );
    },
  });
}
