import { candleSchema, isAligned, type IngestCandle, type Timeframe } from '@tt/shared';
import type { DiscardedRow, NormalizeResult } from '../adapter.js';
import { binanceKlineRowSchema } from './types.js';

export {
  DISCARD_REASONS,
  type DiscardReason,
  type DiscardedRow,
  type NormalizeResult,
} from '../adapter.js';

const NUMERIC_FIELDS = ['t', 'o', 'h', 'l', 'c', 'v'] as const;

export function normalizeCandles(rows: readonly unknown[], timeframe: Timeframe): NormalizeResult {
  const candles: IngestCandle[] = [];
  const discarded: DiscardedRow[] = [];

  rows.forEach((raw, index) => {
    const row = binanceKlineRowSchema.safeParse(raw);
    if (!row.success) {
      discarded.push({
        index,
        reason: 'malformed',
        detail:
          'se esperaba una fila [openTime, o, h, l, c, v, closeTime, quoteVolume] con los tiempos numericos y los precios en string',
      });
      return;
    }

    const [ts, open, high, low, close, volume, , quoteVolume] = row.data;
    const values = {
      t: ts,
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

    const quote = Number(quoteVolume);
    candles.push(
      Number.isFinite(quote) && quote >= 0 ? { ...candle.data, q: quote } : candle.data,
    );
  });

  candles.sort((a, b) => a.t - b.t);

  return { candles, discarded };
}
