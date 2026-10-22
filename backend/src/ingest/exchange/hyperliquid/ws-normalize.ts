import { z } from 'zod';
import type { Timeframe } from '@tt/shared';
import { fromInterval, hyperliquidCandleSchema, toInterval } from './types.js';

export const HYPERLIQUID_WS_DEFAULT_URL = 'wss://api.hyperliquid.xyz/ws';
export const HYPERLIQUID_WS_PING = JSON.stringify({ method: 'ping' });

/** Hyperliquid cierra por inactividad al minuto: el ping va bastante por debajo. */
export const HYPERLIQUID_WS_PING_INTERVAL_MS = 20_000;
export const HYPERLIQUID_WS_PING_MAX_MS = 50_000;

const subscriptionSchema = z.object({
  type: z.string(),
  coin: z.string(),
  interval: z.string().optional(),
});

// El pong llega sin `data`, asi que el campo es opcional.
const envelopeSchema = z.object({ channel: z.string(), data: z.unknown().optional() });

const subscriptionResponseSchema = z.object({
  method: z.string(),
  subscription: subscriptionSchema,
});

const candleDataSchema = hyperliquidCandleSchema.extend({ s: z.string(), i: z.string() });

export type ParsedWsMessage =
  | { kind: 'pong' }
  | { kind: 'subscribed'; symbol: string; timeframe: Timeframe }
  | { kind: 'error'; message: string }
  | { kind: 'candle'; symbol: string; timeframe: Timeframe; row: unknown }
  | { kind: 'unparsable'; detail: string };

function preview(text: string): string {
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

export function parseHyperliquidWsMessage(text: string): ParsedWsMessage {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return { kind: 'unparsable', detail: `no es JSON: ${preview(text)}` };
  }

  const envelope = envelopeSchema.safeParse(payload);
  if (!envelope.success) {
    return { kind: 'unparsable', detail: `no encaja en {channel, data}: ${preview(text)}` };
  }

  if (envelope.data.channel === 'pong') return { kind: 'pong' };

  if (envelope.data.channel === 'error') {
    return { kind: 'error', message: String(envelope.data.data) };
  }

  if (envelope.data.channel === 'subscriptionResponse') {
    const response = subscriptionResponseSchema.safeParse(envelope.data.data);
    const interval = response.success ? response.data.subscription.interval : undefined;
    const timeframe = interval === undefined ? undefined : fromInterval(interval);
    if (!response.success || timeframe === undefined) {
      return {
        kind: 'unparsable',
        detail: `confirmacion de suscripcion sin canal de velas conocido: ${preview(text)}`,
      };
    }
    return { kind: 'subscribed', symbol: response.data.subscription.coin, timeframe };
  }

  if (envelope.data.channel !== 'candle') {
    return { kind: 'unparsable', detail: `canal no manejado: ${envelope.data.channel}` };
  }

  const candle = candleDataSchema.safeParse(envelope.data.data);
  if (!candle.success) {
    return { kind: 'unparsable', detail: `vela con forma inesperada: ${preview(text)}` };
  }

  const timeframe = fromInterval(candle.data.i);
  if (timeframe === undefined) {
    return { kind: 'unparsable', detail: `intervalo desconocido: ${candle.data.i}` };
  }

  return { kind: 'candle', symbol: candle.data.s, timeframe, row: envelope.data.data };
}

export function buildSubscribeMessage(symbol: string, timeframe: Timeframe): string {
  return JSON.stringify({
    method: 'subscribe',
    subscription: { type: 'candle', coin: symbol, interval: toInterval(timeframe) },
  });
}

export function buildUnsubscribeMessage(symbol: string, timeframe: Timeframe): string {
  return JSON.stringify({
    method: 'unsubscribe',
    subscription: { type: 'candle', coin: symbol, interval: toInterval(timeframe) },
  });
}
