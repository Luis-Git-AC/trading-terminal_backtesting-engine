import { z } from 'zod';
import { timeframeSchema } from './timeframe.js';

export const CANDLES_MAX_LIMIT = 5000;

const SYMBOL_PATTERN = /^[A-Z0-9]{4,20}$/;

export const symbolSchema = z
  .string()
  .transform((value) => value.toUpperCase())
  .refine((value) => SYMBOL_PATTERN.test(value), {
    error: 'El simbolo debe ser alfanumerico en mayusculas, de 4 a 20 caracteres',
  });

export const timestampParamSchema = z.union([
  z
    .string()
    .regex(/^\d+$/, { error: 'Se espera un epoch en milisegundos o una fecha ISO 8601' })
    .transform((value) => Number(value))
    .refine((value) => Number.isSafeInteger(value) && value >= 0, {
      error: 'Epoch fuera de rango',
    }),
  z
    .string()
    .datetime({ offset: true })
    .transform((value) => Date.parse(value)),
  z
    .string()
    .datetime()
    .transform((value) => Date.parse(value)),
]);

export const CHECK_STATES = ['ok', 'error'] as const;

export const checkStateSchema = z.enum(CHECK_STATES);

export const ingestHealthSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  lastCandleAgeSec: z.number().nullable(),
});

export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  uptimeSec: z.number().int().nonnegative(),
  version: z.string(),
  checks: z.object({
    db: checkStateSchema,
    redis: checkStateSchema,
    ingest: z.union([ingestHealthSchema, checkStateSchema]).optional(),
  }),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const marketSymbolSchema = z.object({
  symbol: z.string(),
  timeframes: z.array(timeframeSchema),
  pricePrecision: z.number().int().nonnegative(),
  qtyPrecision: z.number().int().nonnegative(),
});

export type MarketSymbol = z.infer<typeof marketSymbolSchema>;

export const marketsResponseSchema = z.object({
  exchange: z.string(),
  symbols: z.array(marketSymbolSchema),
});

export type MarketsResponse = z.infer<typeof marketsResponseSchema>;

export const coverageParamsSchema = z.object({ symbol: symbolSchema });

export const coverageQuerySchema = z.object({ timeframe: timeframeSchema });

export const coverageGapSchema = z.object({
  from: z.string(),
  to: z.string(),
  filled: z.boolean(),
});

export const coverageResponseSchema = z.object({
  symbol: z.string(),
  timeframe: timeframeSchema,
  from: z.string().nullable(),
  to: z.string().nullable(),
  candles: z.number().int().nonnegative(),
  expected: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
  gaps: z.array(coverageGapSchema),
  backfill: z.object({
    done: z.boolean(),
    cursor: z.string().nullable(),
  }),
});

export type CoverageResponse = z.infer<typeof coverageResponseSchema>;

export const candlesQuerySchema = z.object({
  symbol: symbolSchema,
  timeframe: timeframeSchema,
  from: timestampParamSchema,
  to: timestampParamSchema.optional(),
  limit: z
    .string()
    .regex(/^\d+$/, { error: 'limit debe ser un entero' })
    .transform((value) => Number(value))
    .refine((value) => value >= 1, { error: 'limit debe ser al menos 1' })
    .optional(),
});

export type CandlesQuery = z.infer<typeof candlesQuerySchema>;

export const compactCandleSchema = z.object({
  t: z.number().int().nonnegative(),
  o: z.number(),
  h: z.number(),
  l: z.number(),
  c: z.number(),
  v: z.number(),
});

export const candlesResponseSchema = z.object({
  symbol: z.string(),
  timeframe: timeframeSchema,
  count: z.number().int().nonnegative(),
  candles: z.array(compactCandleSchema),
  nextFrom: z.number().int().nonnegative().nullable(),
});

export type CandlesResponse = z.infer<typeof candlesResponseSchema>;
