import { z } from 'zod';

export const COLLECTOR_QUEUE_NAME = 'collector';

export const collectorJobSchema = z.object({
  sourceId: z.string().min(1),
});

export type CollectorJob = z.infer<typeof collectorJobSchema>;

/** Cola del rol `brain`: un job por documento a embeber. */
export const BRAIN_QUEUE_NAME = 'brain';

export const brainJobSchema = z.object({
  documentId: z.uuid(),
});

export type BrainJob = z.infer<typeof brainJobSchema>;

export const SOURCE_STATES = ['ok', 'error', 'pending'] as const;

export type SourceState = (typeof SOURCE_STATES)[number];

export const sourceHealthSchema = z.object({
  id: z.string(),
  state: z.enum(SOURCE_STATES),
  lastOkAt: z.number().int().nullable(),
  lastErrorAt: z.number().int().nullable(),
  lastError: z.string().nullable(),
  items: z.number().int().nonnegative().nullable(),
});

export type SourceHealth = z.infer<typeof sourceHealthSchema>;

export const sourcesHealthSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  sources: z.array(sourceHealthSchema),
});

export type SourcesHealth = z.infer<typeof sourcesHealthSchema>;

export function sourceStateKey(sourceId: string): string {
  return `source:state:${sourceId}`;
}
