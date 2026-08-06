import { z } from 'zod';
import type { Timeframe } from './timeframe.js';

export const CANDLE_SOURCES = ['rest', 'ws'] as const;

export type CandleSource = (typeof CANDLE_SOURCES)[number];

export const candleSourceSchema = z.enum(CANDLE_SOURCES);

export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface CandleRow {
  exchange: string;
  symbol: string;
  timeframe: Timeframe;
  ts: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  quote_volume: string | null;
  source: CandleSource;
  ingested_at: Date;
}

const priceSchema = z.number().nonnegative();

export const candleSchema = z
  .object({
    t: z.number().int().nonnegative(),
    o: priceSchema,
    h: priceSchema,
    l: priceSchema,
    c: priceSchema,
    v: z.number().nonnegative(),
  })
  .refine((candle) => candle.h >= candle.l, {
    error: 'high debe ser >= low',
    path: ['h'],
  })
  .refine((candle) => candle.h >= candle.o && candle.h >= candle.c, {
    error: 'high debe ser >= open y >= close',
    path: ['h'],
  })
  .refine((candle) => candle.l <= candle.o && candle.l <= candle.c, {
    error: 'low debe ser <= open y <= close',
    path: ['l'],
  });

export function candleRowToCandle(row: CandleRow): Candle {
  return {
    t: row.ts.getTime(),
    o: Number(row.open),
    h: Number(row.high),
    l: Number(row.low),
    c: Number(row.close),
    v: Number(row.volume),
  };
}
