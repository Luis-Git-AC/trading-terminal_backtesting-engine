import type { Timeframe } from '@tt/shared';
import type { AppLogger } from '../../observability/logger.js';

export const CACHE_VERSION = 'v1';

export const CANDLES_TTL_OPEN_SEC = 60;

export const CANDLES_TTL_CLOSED_SEC = 3600;

export const COVERAGE_TTL_SEC = 30;

/** Macro y eventos se recogen por cron, no por tick: un minuto de desfase es irrelevante. */
export const MACRO_TTL_SEC = 60;

export interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSec: number): Promise<void>;
}

export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', ttlSec: number): Promise<unknown>;
}

export function candlesKey(
  exchange: string,
  symbol: string,
  timeframe: Timeframe,
  from: number,
  to: number,
  limit: number,
): string {
  return `candles:${CACHE_VERSION}:${exchange}:${symbol}:${timeframe}:${from}:${to}:${limit}`;
}

export function coverageKey(exchange: string, symbol: string, timeframe: Timeframe): string {
  return `coverage:${CACHE_VERSION}:${exchange}:${symbol}:${timeframe}`;
}

/** `asOf` entra en la clave: sin el, una consulta point-in-time serviria la respuesta de otra. */
function asOfPart(asOf: number | undefined): string {
  return asOf === undefined ? 'now' : String(asOf);
}

export function macroKey(
  source: string,
  seriesId: string,
  from: number,
  to: number,
  limit: number,
  asOf?: number,
): string {
  return `macro:${CACHE_VERSION}:${source}:${seriesId}:${from}:${to}:${limit}:${asOfPart(asOf)}`;
}

export function eventsKey(
  from: number,
  to: number,
  limit: number,
  tags: readonly string[],
  asOf?: number,
): string {
  const asset = tags.length === 0 ? 'all' : [...tags].sort().join('+');
  return `events:${CACHE_VERSION}:${from}:${to}:${limit}:${asset}:${asOfPart(asOf)}`;
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
