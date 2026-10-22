import { z } from 'zod';
import type { Timeframe } from '@tt/shared';
import { toInterval } from './types.js';

export const BINANCE_WS_DEFAULT_URL = 'wss://fstream.binance.com/stream';

/**
 * Binance corta la conexion a las 24 h. Se recicla antes para que el corte no llegue nunca
 * de sorpresa: la reconexion reactiva perderia la vela en curso.
 */
export const BINANCE_WS_MAX_LIFETIME_MS = 23 * 60 * 60 * 1000;

const INTERVALS: Readonly<Record<string, Timeframe>> = { '1m': '1m', '15m': '15m', '1h': '1h' };

export function toStreamName(symbol: string, timeframe: Timeframe): string {
  return `${symbol.toLowerCase()}@kline_${toInterval(timeframe)}`;
}

export function fromInterval(interval: string): Timeframe | undefined {
  return INTERVALS[interval];
}

const klineSchema = z.object({
  t: z.number(),
  T: z.number(),
  i: z.string(),
  o: z.string(),
  h: z.string(),
  l: z.string(),
  c: z.string(),
  v: z.string(),
  q: z.string(),
  x: z.boolean(),
});

export type BinanceKline = z.infer<typeof klineSchema>;

const pushSchema = z.object({
  stream: z.string(),
  data: z.object({ e: z.string(), s: z.string(), k: klineSchema }),
});

const ackSchema = z.object({ id: z.number(), result: z.null() });

const errorSchema = z.object({
  error: z.object({ code: z.number(), msg: z.string() }),
  id: z.number().optional(),
});

export type ParsedWsMessage =
  | { kind: 'ack'; id: number }
  | { kind: 'error'; id: number | undefined; code: string; message: string }
  | { kind: 'push'; symbol: string; kline: BinanceKline }
  | { kind: 'unparsable'; detail: string };

function preview(text: string): string {
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

export function parseBinanceWsMessage(text: string): ParsedWsMessage {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return { kind: 'unparsable', detail: `no es JSON: ${preview(text)}` };
  }

  const ack = ackSchema.safeParse(payload);
  if (ack.success) return { kind: 'ack', id: ack.data.id };

  const failed = errorSchema.safeParse(payload);
  if (failed.success) {
    return {
      kind: 'error',
      id: failed.data.id,
      code: String(failed.data.error.code),
      message: failed.data.error.msg,
    };
  }

  const push = pushSchema.safeParse(payload);
  if (push.success) {
    return { kind: 'push', symbol: push.data.data.s, kline: push.data.data.k };
  }

  return {
    kind: 'unparsable',
    detail: `no encaja ni en {result, id} ni en {error} ni en {stream, data.k}: ${preview(text)}`,
  };
}

/** La fila que espera `normalizeCandles`: la del REST, para no tener dos normalizadores. */
export function klineToRow(kline: BinanceKline): readonly unknown[] {
  return [kline.t, kline.o, kline.h, kline.l, kline.c, kline.v, kline.T, kline.q];
}

export function buildSubscribeMessage(
  symbol: string,
  timeframe: Timeframe,
  id: number,
): string {
  return JSON.stringify({ method: 'SUBSCRIBE', params: [toStreamName(symbol, timeframe)], id });
}

export function buildUnsubscribeMessage(
  symbol: string,
  timeframe: Timeframe,
  id: number,
): string {
  return JSON.stringify({ method: 'UNSUBSCRIBE', params: [toStreamName(symbol, timeframe)], id });
}
