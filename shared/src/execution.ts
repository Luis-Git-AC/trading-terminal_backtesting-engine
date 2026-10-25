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

export const MARKET_EVENT_TYPES = ['fred-release', 'eia-wpsr', 'cftc-cot'] as const;

export type MarketEventType = (typeof MARKET_EVENT_TYPES)[number];

export const MAX_BLOCKED_WINDOWS = 2_000;

export const MAX_EVENT_MARGIN_MS = 7 * 86_400_000;

const windowEdgeSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const blockedWindowSchema = z
  .object({ from: windowEdgeSchema, to: windowEdgeSchema })
  .refine((window) => window.to >= window.from, {
    error: 'to no puede ser anterior a from',
    path: ['to'],
  });

export type BlockedWindow = z.infer<typeof blockedWindowSchema>;

const marginSchema = z.number().int().min(0).max(MAX_EVENT_MARGIN_MS);

export const eventBlackoutSchema = z.object({
  types: z.array(z.enum(MARKET_EVENT_TYPES)).min(1).max(MARKET_EVENT_TYPES.length),
  beforeMs: marginSchema,
  afterMs: marginSchema,
});

export type EventBlackout = z.infer<typeof eventBlackoutSchema>;

export const execConfigSchema = z.object({
  initialCapital: z.number().positive().max(1e12),
  riskPerTradePct: z.number().positive().max(100),
  feeBps: z.number().min(0).max(1_000),
  slippageBps: z.number().min(0).max(1_000),
  fillModel: fillModelSchema.default('next-open'),
  /** Con `true` no se abre posicion en una vela fuera de sesion (F8-T5). Las velas no se quitan de la serie. */
  excludeOutOfSession: z.boolean().optional(),
  blockedWindows: z.array(blockedWindowSchema).max(MAX_BLOCKED_WINDOWS).optional(),
  eventBlackout: eventBlackoutSchema.optional(),
});

export type ExecConfigInput = z.infer<typeof execConfigSchema>;

export function isEmptyBlackout(exec: {
  readonly eventBlackout?: EventBlackout | undefined;
  readonly blockedWindows?: readonly BlockedWindow[] | undefined;
}): boolean {
  return exec.eventBlackout !== undefined && (exec.blockedWindows?.length ?? 0) === 0;
}
