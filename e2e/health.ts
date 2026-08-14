import { z } from 'zod';

export const healthBodySchema = z.object({
  status: z.enum(['ok', 'degraded']),
  uptimeSec: z.number(),
  version: z.string(),
  checks: z.object({
    db: z.enum(['ok', 'error']),
    redis: z.enum(['ok', 'error']),
  }),
});

export type HealthBody = z.infer<typeof healthBodySchema>;

export function isHealthy(body: unknown): boolean {
  const parsed = healthBodySchema.safeParse(body);
  if (!parsed.success) return false;
  return parsed.data.checks.db === 'ok' && parsed.data.checks.redis === 'ok';
}

export interface ProbeHealthOptions {
  readonly url: string;
  readonly fetchImpl?: typeof fetch;
}

export async function probeHealth(options: ProbeHealthOptions): Promise<HealthBody | undefined> {
  const call = options.fetchImpl ?? fetch;
  const response = await call(options.url);
  const body: unknown = await response.json();
  return isHealthy(body) ? healthBodySchema.parse(body) : undefined;
}

export function apiUrlFrom(source: NodeJS.ProcessEnv): string {
  return source.E2E_API_URL ?? `http://localhost:${source.E2E_API_PORT ?? '4000'}`;
}
