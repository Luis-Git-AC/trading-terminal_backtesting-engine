import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { z } from 'zod';
import type { Candle, Timeframe } from '@tt/shared';
import { rawDataToString } from '../ingest/ws/resilient-socket.js';
import { toCandleChannel } from '../ingest/exchange/bitget/ws-normalize.js';

const requestSchema = z.object({
  op: z.string(),
  args: z.array(z.object({ instType: z.string(), channel: z.string(), instId: z.string() })),
});

export interface FakeBitgetWs {
  url: string;
  clients: ServerSocket[];
  subscriptions: string[];
  connections(): number;
  push(frame: string): void;
  pushCandle(candle: Candle, symbol: string, timeframe: Timeframe): void;
  cutConnections(): void;
  stop(): Promise<void>;
}

export function updateFrame(candle: Candle, symbol: string, timeframe: Timeframe): string {
  return JSON.stringify({
    action: 'update',
    arg: { instType: 'USDT-FUTURES', channel: toCandleChannel(timeframe), instId: symbol },
    data: [
      [
        String(candle.t),
        String(candle.o),
        String(candle.h),
        String(candle.l),
        String(candle.c),
        String(candle.v),
        '1',
        '1',
      ],
    ],
    ts: candle.t + 1,
  });
}

export async function startFakeBitgetWs(): Promise<FakeBitgetWs> {
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
      const text = rawDataToString(raw);
      if (text === 'ping') {
        client.send('pong');
        return;
      }

      const request = requestSchema.safeParse(JSON.parse(text));
      if (!request.success) return;

      for (const arg of request.data.args) {
        subscriptions.push(JSON.stringify(arg));
        client.send(JSON.stringify({ event: request.data.op, arg }));
      }
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
      push(updateFrame(candle, symbol, timeframe));
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
