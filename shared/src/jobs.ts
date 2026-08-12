import { z } from 'zod';

export const BACKTEST_QUEUE_NAME = 'backtest';

export const RUN_STATUSES = ['queued', 'running', 'completed', 'failed', 'cancelled'] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export const runStatusSchema = z.enum(RUN_STATUSES);

export const backtestJobSchema = z.object({
  runId: z.uuid(),
});

export type BacktestJob = z.infer<typeof backtestJobSchema>;

export const runStatusEventSchema = z.object({
  type: z.literal('status'),
  runId: z.uuid(),
  status: runStatusSchema,
  barsTotal: z.number().int().nonnegative(),
});

export const runProgressEventSchema = z.object({
  type: z.literal('progress'),
  runId: z.uuid(),
  pct: z.number().min(0).max(100),
  barsDone: z.number().int().nonnegative(),
  trades: z.number().int().nonnegative(),
  equity: z.string(),
  etaMs: z.number().int().nonnegative().nullable(),
});

export const runDoneEventSchema = z.object({
  type: z.literal('done'),
  runId: z.uuid(),
  status: runStatusSchema,
});

export const runErrorEventSchema = z.object({
  type: z.literal('error'),
  runId: z.uuid(),
  code: z.string(),
  message: z.string(),
});

export const runEventSchema = z.discriminatedUnion('type', [
  runStatusEventSchema,
  runProgressEventSchema,
  runDoneEventSchema,
  runErrorEventSchema,
]);

export type RunEvent = z.infer<typeof runEventSchema>;

export type RunStatusEvent = z.infer<typeof runStatusEventSchema>;

export type RunProgressEvent = z.infer<typeof runProgressEventSchema>;

export function runChannel(runId: string): string {
  return `ch:run:${runId}`;
}

export const RUN_CANCEL_TTL_SEC = 3_600;

export function runCancelKey(runId: string): string {
  return `run:cancel:${runId}`;
}
