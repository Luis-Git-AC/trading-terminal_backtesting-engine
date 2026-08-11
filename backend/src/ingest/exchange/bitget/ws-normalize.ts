import { z } from 'zod';
import { isTimeframe, type Timeframe } from '@tt/shared';

export const BITGET_WS_DEFAULT_URL = 'wss://ws.bitget.com/v2/ws/public';
export const BITGET_WS_INST_TYPE = 'USDT-FUTURES';
export const BITGET_WS_PING = 'ping';
export const BITGET_WS_PONG = 'pong';

const CHANNEL_BY_TIMEFRAME = {
  '1m': 'candle1m',
  '15m': 'candle15m',
  '1h': 'candle1H',
} as const satisfies Record<Timeframe, string>;

export type BitgetCandleChannel = (typeof CHANNEL_BY_TIMEFRAME)[Timeframe];

export function toCandleChannel(timeframe: Timeframe): BitgetCandleChannel {
  return CHANNEL_BY_TIMEFRAME[timeframe];
}

export function fromCandleChannel(channel: string): Timeframe | undefined {
  for (const timeframe of Object.keys(CHANNEL_BY_TIMEFRAME)) {
    if (!isTimeframe(timeframe)) continue;
    if (CHANNEL_BY_TIMEFRAME[timeframe] === channel) return timeframe;
  }
  return undefined;
}

const argSchema = z.object({
  instType: z.string(),
  channel: z.string(),
  instId: z.string(),
});

export type BitgetWsArg = z.infer<typeof argSchema>;

const controlSchema = z.object({
  event: z.string(),
  arg: argSchema.optional(),
  code: z.union([z.number(), z.string()]).optional(),
  msg: z.string().optional(),
  op: z.string().optional(),
});

const pushSchema = z.object({
  action: z.enum(['snapshot', 'update']),
  arg: argSchema,
  data: z.array(z.unknown()),
});

export type BitgetWsAction = z.infer<typeof pushSchema>['action'];

export type ParsedWsMessage =
  | { kind: 'pong' }
  | {
      kind: 'control';
      event: string;
      arg: BitgetWsArg | undefined;
      code: string | undefined;
      message: string | undefined;
    }
  | { kind: 'push'; action: BitgetWsAction; arg: BitgetWsArg; rows: readonly unknown[] }
  | { kind: 'unparsable'; detail: string };

export function parseBitgetWsMessage(text: string): ParsedWsMessage {
  if (text === BITGET_WS_PONG) return { kind: 'pong' };

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return { kind: 'unparsable', detail: `no es JSON ni el pong de texto plano: ${preview(text)}` };
  }

  const control = controlSchema.safeParse(payload);
  if (control.success) {
    return {
      kind: 'control',
      event: control.data.event,
      arg: control.data.arg,
      code: control.data.code === undefined ? undefined : String(control.data.code),
      message: control.data.msg,
    };
  }

  const push = pushSchema.safeParse(payload);
  if (push.success) {
    return {
      kind: 'push',
      action: push.data.action,
      arg: push.data.arg,
      rows: push.data.data,
    };
  }

  return {
    kind: 'unparsable',
    detail: `no encaja ni en {event, arg} ni en {action, arg, data}: ${preview(text)}`,
  };
}

function preview(text: string): string {
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

export function buildSubscribeMessage(
  symbol: string,
  timeframe: Timeframe,
  instType: string = BITGET_WS_INST_TYPE,
): string {
  return JSON.stringify({
    op: 'subscribe',
    args: [{ instType, channel: toCandleChannel(timeframe), instId: symbol }],
  });
}

export function buildUnsubscribeMessage(
  symbol: string,
  timeframe: Timeframe,
  instType: string = BITGET_WS_INST_TYPE,
): string {
  return JSON.stringify({
    op: 'unsubscribe',
    args: [{ instType, channel: toCandleChannel(timeframe), instId: symbol }],
  });
}
