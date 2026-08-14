import { runMigrations } from '../backend/src/db/migrate.js';
import { closePool, getPool } from '../backend/src/db/pool.js';
import { createCandlesRepository } from '../backend/src/db/repositories/candles.repo.js';
import { loadCandleFixture, seedFixture, type SeedSeriesResult } from '../e2e/fixtures/seed.js';
import { apiUrlFrom, probeHealth } from '../e2e/health.js';
import { waitFor } from '../e2e/wait.js';

export const HEALTH_TIMEOUT_MS = 60_000;
export const DB_TIMEOUT_MS = 60_000;

export {
  apiUrlFrom,
  healthBodySchema,
  isHealthy,
  probeHealth,
  type HealthBody,
} from '../e2e/health.js';

export function summarizeSeed(results: readonly SeedSeriesResult[]): string {
  return results
    .map(
      (result) =>
        `    ${result.symbol} ${result.timeframe}: ${result.bars} vela(s), ${result.written} escrita(s), ` +
        `${new Date(result.fromTs).toISOString()} -> ${new Date(result.toTs).toISOString()}`,
    )
    .join('\n');
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
