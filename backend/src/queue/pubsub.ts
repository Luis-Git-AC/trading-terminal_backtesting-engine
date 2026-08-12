import { Redis } from 'ioredis';
import { runChannel, type Candle, type RunEvent, type Timeframe } from '@tt/shared';

export const CANDLE_CHANNEL_PREFIX = 'ch:candles';

export interface CandleTick extends Candle {
  closed: boolean;
}

export function candleChannel(symbol: string, timeframe: Timeframe): string {
  return `${CANDLE_CHANNEL_PREFIX}:${symbol}:${timeframe}`;
}

export interface RedisPublisher {
  publish(channel: string, message: string): Promise<unknown>;
  quit(): Promise<unknown>;
}

export interface CandlePublisher {
  publishCandle(
    symbol: string,
    timeframe: Timeframe,
    candle: Candle,
    closed: boolean,
  ): Promise<void>;
  close(): Promise<void>;
}

export interface CandlePublisherOptions {
  redis: RedisPublisher;
  onError?: (error: Error) => void;
}

export interface RedisClientOptions {
  onError?: (error: Error) => void;
  enableOfflineQueue?: boolean;
}

export function createRedisClient(url: string, options: RedisClientOptions = {}): Redis {
  const client = new Redis(url, {
    maxRetriesPerRequest: null,
    lazyConnect: false,
    enableOfflineQueue: options.enableOfflineQueue ?? true,
  });

  client.on('error', (error: Error) => {
    options.onError?.(error);
  });

  return client;
}

export interface RunEventPublisher {
  publish(event: RunEvent): Promise<void>;
}

export interface RunEventPublisherOptions {
  redis: Pick<RedisPublisher, 'publish'>;
  onError?: (error: Error) => void;
}

export function createRunEventPublisher(options: RunEventPublisherOptions): RunEventPublisher {
  const onError = options.onError ?? ((): void => undefined);

  return {
    async publish(event: RunEvent): Promise<void> {
      try {
        await options.redis.publish(runChannel(event.runId), JSON.stringify(event));
      } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
}

export function toCandleTick(candle: Candle, closed: boolean): CandleTick {
  return { ...candle, closed };
}

export function createCandlePublisher(options: CandlePublisherOptions): CandlePublisher {
  const { redis } = options;
  const onError = options.onError ?? ((): void => undefined);

  return {
    async publishCandle(symbol, timeframe, candle, closed) {
      try {
        await redis.publish(candleChannel(symbol, timeframe), JSON.stringify(toCandleTick(candle, closed)));
      } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)));
      }
    },

    async close() {
      await redis.quit();
    },
  };
}
