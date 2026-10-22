import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { z } from 'zod';
import type { Candle, Timeframe } from '@tt/shared';
import { toInterval } from '../ingest/exchange/binance/types.js';
import { toStreamName } from '../ingest/exchange/binance/ws-normalize.js';
import { rawDataToString } from '../ingest/ws/resilient-socket.js';

const requestSchema = z.object({
  method: z.string(),
  params: z.array(z.string()),
  id: z.number(),
});

export interface FakeBinanceWs {
  url: string;
  clients: ServerSocket[];
  subscriptions: string[];
  connections(): number;
  push(frame: string): void;
  pushCandle(candle: Candle, symbol: string, timeframe: Timeframe, closed?: boolean): void;
  cutConnections(): void;
  stop(): Promise<void>;
}

export function klineFrame(
  candle: Candle,
  symbol: string,
  timeframe: Timeframe,
  closed: boolean,
): string {
  return JSON.stringify({
    stream: toStreamName(symbol, timeframe),
    data: {
      e: 'kline',
      E: candle.t + 1,
      s: symbol,
      k: {
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
        x: closed,
        q: '1',
      },
    },
  });
}

export async function startFakeBinanceWs(): Promise<FakeBinanceWs> {
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

      for (const stream of request.data.params) subscriptions.push(stream);
      client.send(JSON.stringify({ result: null, id: request.data.id }));
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
    pushCandle(candle, symbol, timeframe, closed = true) {
      push(klineFrame(candle, symbol, timeframe, closed));
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
