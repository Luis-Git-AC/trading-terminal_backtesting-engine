import { Redis } from 'ioredis';

export interface QueueConnectionOptions {
  readonly onError?: (error: Error) => void;
}

export function createQueueConnection(
  url: string,
  options: QueueConnectionOptions = {},
): Redis {
  const client = new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  client.on('error', (error: Error) => {
    options.onError?.(error);
  });

  return client;
}
