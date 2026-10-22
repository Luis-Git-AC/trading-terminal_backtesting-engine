import { candleSchema, isAligned, type IngestCandle, type Timeframe } from '@tt/shared';
import type { DiscardedRow, NormalizeResult } from '../adapter.js';
import { hyperliquidCandleSchema } from './types.js';

export {
  DISCARD_REASONS,
  type DiscardReason,
  type DiscardedRow,
  type NormalizeResult,
} from '../adapter.js';

const NUMERIC_FIELDS = ['t', 'o', 'h', 'l', 'c', 'v'] as const;

/** Mismo vocabulario de descartes que Binance, aunque la fila sea un objeto. */
export function normalizeCandles(rows: readonly unknown[], timeframe: Timeframe): NormalizeResult {
  const candles: IngestCandle[] = [];
  const discarded: DiscardedRow[] = [];

  rows.forEach((raw, index) => {
    const row = hyperliquidCandleSchema.safeParse(raw);
    if (!row.success) {
      discarded.push({
        index,
        reason: 'malformed',
        detail: 'se esperaba un objeto {t, T, o, h, l, c, v} con los precios en string',
      });
      return;
    }

    const values = {
      t: row.data.t,
      o: Number(row.data.o),
      h: Number(row.data.h),
      l: Number(row.data.l),
      c: Number(row.data.c),
      v: Number(row.data.v),
    };

    const notNumeric = NUMERIC_FIELDS.find((field) => !Number.isFinite(values[field]));
    if (notNumeric !== undefined) {
      discarded.push({
        index,
        reason: 'not-numeric',
        detail: `el campo ${notNumeric} no es un numero: ${JSON.stringify(row.data[notNumeric === 't' ? 't' : notNumeric])}`,
      });
      return;
    }

    if (!Number.isSafeInteger(values.t) || values.t < 0) {
      discarded.push({
        index,
        reason: 'invalid-ts',
        detail: `t ${values.t} no es un epoch en ms entero y no negativo`,
      });
      return;
    }

    if (!isAligned(values.t, timeframe)) {
      discarded.push({
        index,
        reason: 'unaligned',
        detail: `t ${values.t} no cae en un limite de vela de ${timeframe}`,
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
