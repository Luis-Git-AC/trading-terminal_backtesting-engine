import { z } from 'zod';

export const STRATEGY_PARAM_TYPES = ['int', 'float', 'bool', 'enum'] as const;

export type StrategyParamType = (typeof STRATEGY_PARAM_TYPES)[number];

export const strategyParamSchema = z.object({
  key: z.string().min(1),
  type: z.enum(STRATEGY_PARAM_TYPES),
  default: z.union([z.number(), z.boolean(), z.string()]),
  min: z.number().optional(),
  max: z.number().optional(),
  label: z.string().optional(),
  options: z.array(z.string()).optional(),
});

export type StrategyParam = z.infer<typeof strategyParamSchema>;

export const strategyMetaSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string(),
  params: z.array(strategyParamSchema),
});

export type StrategyMeta = z.infer<typeof strategyMetaSchema>;

export const strategyCatalogSchema = z.object({
  strategies: z.array(strategyMetaSchema),
});

export type StrategyCatalog = z.infer<typeof strategyCatalogSchema>;
