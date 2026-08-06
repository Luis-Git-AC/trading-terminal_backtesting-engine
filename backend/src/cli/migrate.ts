import { createPool } from '../db/pool.js';
import { MigrationError, runMigrations, type MigrationEvent } from '../db/migrate.js';

function report(event: MigrationEvent): void {
  switch (event.kind) {
    case 'applied':
      console.log(`  aplicada  ${event.filename} (${event.durationMs} ms)`);
      break;
    case 'skipped':
      console.log(`  ya estaba ${event.filename}`);
      break;
    case 'notice':
      console.log(`  postgres: ${event.message.trim()}`);
      break;
    case 'warning':
      console.warn(`  aviso: ${event.message}`);
      break;
  }
}

const pool = createPool({ max: 2, applicationName: 'tt-migrate' });

try {
  console.log('Aplicando migraciones...');
  const result = await runMigrations({ pool, log: report });

  console.log(
    `\n${result.applied.length} aplicada(s), ${result.alreadyApplied.length} ya estaban al dia.`,
  );
  console.log(
    result.timescaleVersion === null
      ? 'TimescaleDB: no disponible'
      : `TimescaleDB: ${result.timescaleVersion}`,
  );
} catch (error) {
  if (error instanceof MigrationError) {
    console.error(`\n${error.name}: ${error.message}`);
  } else {
    console.error('\nFallo inesperado aplicando migraciones:', error);
  }
  process.exitCode = 1;
} finally {
  await pool.end();
}
