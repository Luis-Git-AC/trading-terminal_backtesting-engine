import { z } from 'zod';
import { runMigrations } from '../backend/src/db/migrate.js';
import { closePool, getPool } from '../backend/src/db/pool.js';
import { createCandlesRepository } from '../backend/src/db/repositories/candles.repo.js';
import { loadCandleFixture, seedFixture, type SeedSeriesResult } from '../e2e/fixtures/seed.js';
import { waitFor } from '../e2e/wait.js';

export const HEALTH_TIMEOUT_MS = 60_000;
export const DB_TIMEOUT_MS = 60_000;

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

export function summarizeSeed(results: readonly SeedSeriesResult[]): string {
  return results
    .map(
      (result) =>
        `    ${result.symbol} ${result.timeframe}: ${result.bars} vela(s), ${result.written} escrita(s), ` +
        `${new Date(result.fromTs).toISOString()} -> ${new Date(result.toTs).toISOString()}`,
    )
    .join('\n');
}

export function apiUrlFrom(source: NodeJS.ProcessEnv): string {
  return source.E2E_API_URL ?? `http://localhost:${source.E2E_API_PORT ?? '4000'}`;
}

export async function main(): Promise<void> {
  const apiUrl = apiUrlFrom(process.env);
  const startedAt = Date.now();
  const pool = getPool();

  const db = await waitFor(
    async () => {
      await pool.query('SELECT 1');
      return true;
    },
    { label: 'la base de datos', timeoutMs: DB_TIMEOUT_MS },
  );
  console.log(`[e2e-setup] base de datos lista en ${db.elapsedMs} ms`);

  const migrations = await runMigrations({ pool });
  console.log(
    `[e2e-setup] migraciones: ${migrations.applied.length} aplicada(s), ` +
      `${migrations.alreadyApplied.length} ya al dia, timescale ${migrations.timescaleVersion ?? 'no disponible'}`,
  );

  const fixture = loadCandleFixture();
  const seeded = await seedFixture({ candles: createCandlesRepository(pool) });
  const written = seeded.reduce((total, result) => total + result.written, 0);
  console.log(
    `[e2e-setup] fixture real de ${fixture.exchange} capturado el ${fixture.capturedAt}, ` +
      `${written} vela(s) escritas:\n${summarizeSeed(seeded)}`,
  );

  const health = await waitFor(() => probeHealth({ url: `${apiUrl}/api/health` }), {
    label: `el API en ${apiUrl}`,
    timeoutMs: HEALTH_TIMEOUT_MS,
  });
  console.log(
    `[e2e-setup] ${apiUrl}/api/health -> "${health.value.status}" en ${health.elapsedMs} ms ` +
      `(${health.attempts} intento(s), version ${health.value.version})`,
  );

  await closePool();
  console.log(`[e2e-setup] entorno listo en ${Date.now() - startedAt} ms`);
}
