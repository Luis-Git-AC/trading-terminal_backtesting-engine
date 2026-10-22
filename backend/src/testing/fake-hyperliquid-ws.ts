import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { z } from 'zod';
import type { Candle, Timeframe } from '@tt/shared';
import { toInterval } from '../ingest/exchange/hyperliquid/types.js';
import { rawDataToString } from '../ingest/ws/resilient-socket.js';

const requestSchema = z.object({
  method: z.string(),
  subscription: z
    .object({ type: z.string(), coin: z.string(), interval: z.string().optional() })
    .optional(),
});

export interface FakeHyperliquidWs {
  url: string;
  clients: ServerSocket[];
  subscriptions: string[];
  connections(): number;
  push(frame: string): void;
  pushCandle(candle: Candle, symbol: string, timeframe: Timeframe): void;
  cutConnections(): void;
  stop(): Promise<void>;
}

export function candleFrame(candle: Candle, symbol: string, timeframe: Timeframe): string {
  return JSON.stringify({
    channel: 'candle',
    data: {
      t: candle.t,
      T: candle.t + 59_999,
      s: symbol,
      i: toInterval(timeframe),
      o: String(candle.o),
      h: String(candle.h),
      l: String(candle.l),
      c: String(candle.c),
      v: String(candle.v),
      n: 1,
    },
  });
}

export async function startFakeHyperliquidWs(): Promise<FakeHyperliquidWs> {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('se esperaba un puerto TCP');
  }

  const clients: ServerSocket[] = [];
  const subscriptions: string[] = [];
  let opened = 0;

  server.on('connection', (client) => {
    opened += 1;
    clients.push(client);
    client.on('close', () => {
      const index = clients.indexOf(client);
      if (index >= 0) clients.splice(index, 1);
    });
    client.on('message', (raw) => {
      const request = requestSchema.safeParse(JSON.parse(rawDataToString(raw)));
      if (!request.success) return;

      if (request.data.method === 'ping') {
        client.send(JSON.stringify({ channel: 'pong' }));
        return;
      }

      const subscription = request.data.subscription;
      if (subscription === undefined) return;

      if (request.data.method === 'subscribe') {
        subscriptions.push(JSON.stringify(subscription));
      }
      client.send(
        JSON.stringify({
          channel: 'subscriptionResponse',
          data: { method: request.data.method, subscription },
        }),
      );
    });
  });

  const push = (frame: string): void => {
    for (const client of clients) client.send(frame);
  };

  return {
    url: `ws://127.0.0.1:${address.port}`,
    clients,
    subscriptions,
    connections: () => opened,
    push,
    pushCandle(candle, symbol, timeframe) {
      push(candleFrame(candle, symbol, timeframe));
    },
    cutConnections() {
      for (const client of [...clients]) client.terminate();
      clients.length = 0;
    },
    async stop() {
      for (const client of [...clients]) client.terminate();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
