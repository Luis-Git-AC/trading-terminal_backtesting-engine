import type { Timeframe } from '@tt/shared';
import type { AppLogger } from '../../observability/logger.js';

export const CACHE_VERSION = 'v1';

export const CANDLES_TTL_OPEN_SEC = 60;

export const CANDLES_TTL_CLOSED_SEC = 3600;

export const COVERAGE_TTL_SEC = 30;

export interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSec: number): Promise<void>;
}

export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', ttlSec: number): Promise<unknown>;
}

export function candlesKey(
  symbol: string,
  timeframe: Timeframe,
  from: number,
  to: number,
  limit: number,
): string {
  return `candles:${CACHE_VERSION}:${symbol}:${timeframe}:${from}:${to}:${limit}`;
}

export function coverageKey(symbol: string, timeframe: Timeframe): string {
  return `coverage:${CACHE_VERSION}:${symbol}:${timeframe}`;
}

export function createRedisCache(redis: RedisLike): CacheStore {
  return {
    get: (key: string) => redis.get(key),
    set: async (key: string, value: string, ttlSec: number) => {
      await redis.set(key, value, 'EX', ttlSec);
    },
  };
}

export const NO_CACHE: CacheStore = {
  get: () => Promise.resolve(null),
  set: () => Promise.resolve(),
};

export interface CachedOptions<T> {
  readonly cache: CacheStore;
  readonly key: string;
  readonly ttlSec: number;
  readonly logger: AppLogger;
  readonly parse: (raw: string) => T;
  readonly load: () => Promise<T>;
}

export async function cached<T>(options: CachedOptions<T>): Promise<T> {
  let raw: string | null = null;
  try {
    raw = await options.cache.get(options.key);
  } catch (error) {
    options.logger.warn(
      { err: error, key: options.key },
      'cache no disponible, se sirve desde la base de datos',
    );
  }

  if (raw !== null) {
    try {
      const value = options.parse(raw);
      options.logger.debug({ key: options.key, cache: 'hit' }, 'cache');
      return value;
    } catch (error) {
      options.logger.warn({ err: error, key: options.key }, 'entrada de cache ilegible, se recarga');
    }
  }

  options.logger.debug({ key: options.key, cache: 'miss' }, 'cache');
  const value = await options.load();
  try {
    await options.cache.set(options.key, JSON.stringify(value), options.ttlSec);
  } catch (error) {
    options.logger.warn({ err: error, key: options.key }, 'no se pudo escribir en la cache, se sigue');
  }
  return value;
}
