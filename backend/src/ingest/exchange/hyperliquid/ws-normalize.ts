import { z } from 'zod';
import type { Timeframe } from '@tt/shared';
import {
  fromInterval,
  hyperliquidAssetCtxSchema,
  hyperliquidCandleSchema,
  toInterval,
} from './types.js';

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

const assetCtxDataSchema = z.object({ coin: z.string(), ctx: hyperliquidAssetCtxSchema });

export type ParsedWsMessage =
  | { kind: 'pong' }
  | { kind: 'subscribed'; symbol: string; timeframe: Timeframe }
  | { kind: 'subscribed-ctx'; symbol: string }
  | { kind: 'asset-ctx'; symbol: string; funding: number; openInterest: number }
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
    if (response.success && response.data.subscription.type === 'activeAssetCtx') {
      return { kind: 'subscribed-ctx', symbol: response.data.subscription.coin };
    }
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

  if (envelope.data.channel === 'activeAssetCtx') {
    const ctx = assetCtxDataSchema.safeParse(envelope.data.data);
    if (!ctx.success) {
      return { kind: 'unparsable', detail: `activeAssetCtx con forma inesperada: ${preview(text)}` };
    }

    const funding = Number(ctx.data.ctx.funding);
    const openInterest = Number(ctx.data.ctx.openInterest);
    if (!Number.isFinite(funding) || !Number.isFinite(openInterest)) {
      return { kind: 'unparsable', detail: `activeAssetCtx no numerico: ${preview(text)}` };
    }

    return { kind: 'asset-ctx', symbol: ctx.data.coin, funding, openInterest };
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

export function buildAssetCtxSubscribeMessage(symbol: string): string {
  return JSON.stringify({ method: 'subscribe', subscription: { type: 'activeAssetCtx', coin: symbol } });
}

export function buildAssetCtxUnsubscribeMessage(symbol: string): string {
  return JSON.stringify({
    method: 'unsubscribe',
    subscription: { type: 'activeAssetCtx', coin: symbol },
  });
}
