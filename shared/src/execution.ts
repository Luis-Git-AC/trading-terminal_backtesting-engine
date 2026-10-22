import { z } from 'zod';

export const FILL_MODELS = ['next-open'] as const;

export type FillModel = (typeof FILL_MODELS)[number];

export const fillModelSchema = z.enum(FILL_MODELS);

export const SIDES = ['long', 'short'] as const;

export type Side = (typeof SIDES)[number];

export const sideSchema = z.enum(SIDES);

export const EXIT_REASONS = ['stop', 'take-profit', 'signal', 'end-of-data'] as const;

export type ExitReason = (typeof EXIT_REASONS)[number];

export const exitReasonSchema = z.enum(EXIT_REASONS);

export const execConfigSchema = z.object({
  initialCapital: z.number().positive().max(1e12),
  riskPerTradePct: z.number().positive().max(100),
  feeBps: z.number().min(0).max(1_000),
  slippageBps: z.number().min(0).max(1_000),
  fillModel: fillModelSchema.default('next-open'),
  /** Con `true` no se abre posicion en una vela fuera de sesion (F8-T5). Las velas no se quitan de la serie. */
  excludeOutOfSession: z.boolean().optional(),
});

export type ExecConfigInput = z.infer<typeof execConfigSchema>;
