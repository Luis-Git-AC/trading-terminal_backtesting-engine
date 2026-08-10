import { candleSchema, isAligned, type Candle, type Timeframe } from '@tt/shared';
import { bitgetCandleRowSchema } from './types.js';

export const DISCARD_REASONS = [
  'malformed',
  'not-numeric',
  'invalid-ts',
  'unaligned',
  'invalid-candle',
] as const;

export type DiscardReason = (typeof DISCARD_REASONS)[number];

export interface DiscardedRow {
  index: number;
  reason: DiscardReason;
  detail: string;
}

export interface NormalizeResult {
  candles: Candle[];
  discarded: DiscardedRow[];
}

const NUMERIC_FIELDS = ['t', 'o', 'h', 'l', 'c', 'v'] as const;

export function normalizeCandles(
  rows: readonly unknown[],
  timeframe: Timeframe,
): NormalizeResult {
  const candles: Candle[] = [];
  const discarded: DiscardedRow[] = [];

  rows.forEach((raw, index) => {
    const row = bitgetCandleRowSchema.safeParse(raw);
    if (!row.success) {
      discarded.push({
        index,
        reason: 'malformed',
        detail: 'se esperaba un array de al menos 6 strings [ts, o, h, l, c, v]',
      });
      return;
    }

    const [ts, open, high, low, close, volume] = row.data;
    const values = {
      t: Number(ts),
      o: Number(open),
      h: Number(high),
      l: Number(low),
      c: Number(close),
      v: Number(volume),
    };

    const notNumeric = NUMERIC_FIELDS.find((field) => !Number.isFinite(values[field]));
    if (notNumeric !== undefined) {
      discarded.push({
        index,
        reason: 'not-numeric',
        detail: `el campo ${notNumeric} no es un numero: ${JSON.stringify(row.data[NUMERIC_FIELDS.indexOf(notNumeric)])}`,
      });
      return;
    }

    if (!Number.isSafeInteger(values.t) || values.t < 0) {
      discarded.push({
        index,
        reason: 'invalid-ts',
        detail: `ts ${values.t} no es un epoch en ms entero y no negativo`,
      });
      return;
    }

    if (!isAligned(values.t, timeframe)) {
      discarded.push({
        index,
        reason: 'unaligned',
        detail: `ts ${values.t} no cae en un limite de vela de ${timeframe}`,
      });
      return;
    }

    const candle = candleSchema.safeParse(values);
    if (!candle.success) {
      discarded.push({
        index,
        reason: 'invalid-candle',
        detail: candle.error.issues.map((issue) => issue.message).join('; '),
      });
      return;
    }

    candles.push(candle.data);
  });

  candles.sort((a, b) => a.t - b.t);

  return { candles, discarded };
}
