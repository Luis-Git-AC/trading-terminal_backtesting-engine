import { z } from 'zod';
import { symbolSchema, timestampParamSchema } from './api-schemas.js';
import { execConfigSchema, exitReasonSchema, sideSchema } from './execution.js';
import { runStatusSchema } from './jobs.js';
import { timeframeSchema } from './timeframe.js';

export const COMPARE_MAX_IDS = 4;

export const RUNS_MAX_LIMIT = 200;

export const RUNS_DEFAULT_LIMIT = 50;

export const TRADES_MAX_LIMIT = 1_000;

export const TRADES_DEFAULT_LIMIT = 500;

export const SEED_MAX = 4_294_967_295;

export const BACKTEST_WARNINGS = ['coverage-gaps', 'engine-version-mismatch'] as const;

export type BacktestWarning = (typeof BACKTEST_WARNINGS)[number];

export const backtestWarningSchema = z.enum(BACKTEST_WARNINGS);

function queryInt(min: number, max: number) {
  return z
    .string()
    .regex(/^\d+$/, { error: 'Se espera un entero' })
    .transform((value) => Number(value))
    .refine((value) => value >= min && value <= max, {
      error: `Debe estar entre ${min} y ${max}`,
    });
}

export const timestampBodySchema = z.union([
  z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .refine((value) => Number.isSafeInteger(value), { error: 'Epoch fuera de rango' }),
  timestampParamSchema,
]);

export const runIdParamsSchema = z.object({
  id: z.uuid({ error: 'El identificador del run debe ser un uuid' }),
});

export const createBacktestBodySchema = z.object({
  symbol: symbolSchema,
  timeframe: timeframeSchema,
  from: timestampBodySchema,
  to: timestampBodySchema,
  strategyId: z.string().min(1).max(64),
  params: z.record(z.string(), z.unknown()).default({}),
  exec: execConfigSchema,
  seed: z.number().int().min(0).max(SEED_MAX).optional(),
  label: z.string().min(1).max(120).optional(),
});

export type CreateBacktestBody = z.infer<typeof createBacktestBodySchema>;

export const createBacktestResponseSchema = z.object({
  runId: z.uuid(),
  status: runStatusSchema,
  seed: z.number().int().nonnegative(),
  paramsHash: z.string(),
  barsTotal: z.number().int().nonnegative(),
  warnings: z.array(backtestWarningSchema),
});

export type CreateBacktestResponse = z.infer<typeof createBacktestResponseSchema>;

export const listBacktestsQuerySchema = z.object({
  status: runStatusSchema.optional(),
  limit: queryInt(1, RUNS_MAX_LIMIT).optional(),
  offset: queryInt(0, 1_000_000).optional(),
});

export type ListBacktestsQuery = z.infer<typeof listBacktestsQuerySchema>;

export const tradesQuerySchema = z.object({
  limit: queryInt(1, TRADES_MAX_LIMIT).optional(),
  cursor: queryInt(0, 1_000_000).optional(),
});

export type TradesQuery = z.infer<typeof tradesQuerySchema>;

export const compareQuerySchema = z.object({
  ids: z
    .string()
    .transform((raw) => [
      ...new Set(
        raw
          .split(',')
          .map((part) => part.trim())
          .filter((part) => part.length > 0),
      ),
    ])
    .pipe(
      z
        .array(z.uuid({ error: 'Cada id debe ser un uuid' }))
        .min(1, { error: 'Hace falta al menos un id' })
        .max(COMPARE_MAX_IDS, { error: `Como maximo ${COMPARE_MAX_IDS} runs a la vez` }),
    ),
});

export type CompareQuery = z.infer<typeof compareQuerySchema>;

export const backtestMetricsSchema = z.object({
  netProfit: z.string(),
  netProfitPct: z.number(),
  maxDrawdown: z.number(),
  maxDrawdownQuote: z.string(),
  winRate: z.number().nullable(),
  profitFactor: z.number().nullable(),
  expectancyR: z.number().nullable(),
  trades: z.number().int().nonnegative(),
  wins: z.number().int().nonnegative(),
  losses: z.number().int().nonnegative(),
  avgWinR: z.number().nullable(),
  avgLossR: z.number().nullable(),
  largestWinR: z.number().nullable(),
  largestLossR: z.number().nullable(),
  exposurePct: z.number(),
  barsTotal: z.number().int().nonnegative(),
  openAtEnd: z.boolean(),
});

export type BacktestMetricsResponse = z.infer<typeof backtestMetricsSchema>;

export const runTimingsSchema = z.object({
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
});

export const runSummarySchema = z.object({
  id: z.uuid(),
  status: runStatusSchema,
  symbol: z.string(),
  timeframe: timeframeSchema,
  strategyId: z.string(),
  label: z.string().nullable(),
  seed: z.number().int().nonnegative(),
  engineVersion: z.string(),
  paramsHash: z.string(),
  range: z.object({ from: z.string(), to: z.string() }),
  progress: z.object({
    barsDone: z.number().int().nonnegative(),
    barsTotal: z.number().int().nonnegative().nullable(),
  }),
  metrics: backtestMetricsSchema.nullable(),
  error: z.string().nullable(),
  timings: runTimingsSchema,
});

export type RunSummary = z.infer<typeof runSummarySchema>;

export const runDetailSchema = runSummarySchema.extend({
  params: z.record(z.string(), z.unknown()),
  exec: execConfigSchema,
});

export type RunDetail = z.infer<typeof runDetailSchema>;

export const listBacktestsResponseSchema = z.object({
  runs: z.array(runSummarySchema),
});

export type ListBacktestsResponse = z.infer<typeof listBacktestsResponseSchema>;

export const backtestTradeSchema = z.object({
  seq: z.number().int().positive(),
  side: sideSchema,
  entryTs: z.number().int().nonnegative(),
  entryPrice: z.string(),
  exitTs: z.number().int().nonnegative(),
  exitPrice: z.string(),
  qty: z.string(),
  fees: z.string(),
  pnlQuote: z.string(),
  pnlR: z.number(),
  exitReason: exitReasonSchema,
  maeR: z.number(),
  mfeR: z.number(),
});

export type BacktestTrade = z.infer<typeof backtestTradeSchema>;

export const tradesResponseSchema = z.object({
  trades: z.array(backtestTradeSchema),
  nextCursor: z.number().int().nonnegative().nullable(),
});

export type TradesResponse = z.infer<typeof tradesResponseSchema>;

export const equityPointSchema = z.object({
  t: z.number().int().nonnegative(),
  equity: z.string(),
  dd: z.number(),
});

export const equityResponseSchema = z.object({
  points: z.array(equityPointSchema),
});

export type EquityResponse = z.infer<typeof equityResponseSchema>;

export const compareCurveSchema = z.object({
  runId: z.uuid(),
  points: z.array(z.object({ t: z.number().int().nonnegative(), value: z.number() })),
});

export const compareResponseSchema = z.object({
  runs: z.array(runSummarySchema),
  curves: z.array(compareCurveSchema),
  warnings: z.array(backtestWarningSchema),
});

export type CompareResponse = z.infer<typeof compareResponseSchema>;

export const cancelBacktestResponseSchema = z.object({
  runId: z.uuid(),
  status: runStatusSchema,
});

export type CancelBacktestResponse = z.infer<typeof cancelBacktestResponseSchema>;
