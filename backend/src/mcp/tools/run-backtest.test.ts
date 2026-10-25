import { describe, expect, it } from 'vitest';
import { AppError } from '../../api/errors.js';
import { backtestRateLimitMessage } from '../../api/middleware/rate-limit.js';
import { createRunRateLimiter } from './run-backtest.js';

function rejection(take: () => void): AppError | undefined {
  try {
    take();
    return undefined;
  } catch (error) {
    return error instanceof AppError ? error : undefined;
  }
}

describe('createRunRateLimiter', () => {
  it('deja pasar max por ventana, rechaza el siguiente con el mensaje del API y se reinicia', () => {
    let t = 1_000;
    const take = createRunRateLimiter({ windowMs: 60_000, max: 2 }, () => t);

    take();
    take();
    const error = rejection(take);
    expect(error?.code).toBe('RATE_LIMITED');
    expect(error?.status).toBe(429);
    expect(error?.message).toBe(backtestRateLimitMessage(2, 60_000));

    t += 59_999;
    expect(rejection(take)?.code).toBe('RATE_LIMITED');

    t += 1;
    expect(() => {
      take();
    }).not.toThrow();
  });
});
