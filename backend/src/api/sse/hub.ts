import type { AppLogger } from '../../observability/logger.js';

export type ChannelListener = (message: string) => void;

export interface SubscriberLike {
  subscribe(channel: string): Promise<unknown>;
  unsubscribe(channel: string): Promise<unknown>;
  on(event: 'message', listener: (channel: string, message: string) => void): unknown;
}

export interface SseHub {
  subscribe(channel: string, listener: ChannelListener): Promise<() => Promise<void>>;
  listenerCount(channel: string): number;
  channels(): readonly string[];
}

export interface SseHubOptions {
  readonly subscriber: SubscriberLike;
  readonly logger: AppLogger;
}

export function createSseHub(options: SseHubOptions): SseHub {
  const { subscriber, logger } = options;
  const channels = new Map<string, Set<ChannelListener>>();

  subscriber.on('message', (channel: string, message: string) => {
    const listeners = channels.get(channel);
    if (listeners === undefined) {
      return;
    }
    for (const listener of [...listeners]) {
      try {
        listener(message);
      } catch (error) {
        logger.warn({ err: error, channel }, 'un cliente sse fallo al recibir, se continua');
      }
    }
  });

  return {
    async subscribe(channel: string, listener: ChannelListener): Promise<() => Promise<void>> {
      let listeners = channels.get(channel);

      if (listeners === undefined) {
        listeners = new Set();
        channels.set(channel, listeners);
        try {
          await subscriber.subscribe(channel);
        } catch (error) {
          channels.delete(channel);
          throw error;
        }
      }

      listeners.add(listener);
      let released = false;

      return async (): Promise<void> => {
        if (released) {
          return;
        }
        released = true;

        const current = channels.get(channel);
        if (current === undefined) {
          return;
        }
        current.delete(listener);
        if (current.size > 0) {
          return;
        }

        channels.delete(channel);
        try {
          await subscriber.unsubscribe(channel);
        } catch (error) {
          logger.warn({ err: error, channel }, 'no se pudo cancelar la suscripcion, se continua');
        }
      };
    },

    listenerCount(channel: string): number {
      return channels.get(channel)?.size ?? 0;
    },

    channels(): readonly string[] {
      return [...channels.keys()];
    },
  };
}
