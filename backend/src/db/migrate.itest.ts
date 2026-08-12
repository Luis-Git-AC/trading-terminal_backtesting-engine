import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MigrationChecksumError, runMigrations } from './migrate.js';
import { createScratchDatabase, type ScratchDatabase } from '../testing/scratch-db.js';

let db: ScratchDatabase;

beforeAll(async () => {
  db = await createScratchDatabase({ applicationName: 'tt-itest-migrate' });
});

afterAll(async () => {
  await db.drop();
});

describe('runMigrations sobre una base de datos limpia', () => {
  it('aplica todas las migraciones desde cero y las registra', async () => {
    const result = await runMigrations({ pool: db.pool });

    expect(result.applied).toEqual(['000_init.sql', '001_candles.sql', '002_ingest.sql', '003_backtests.sql']);
    expect(result.alreadyApplied).toEqual([]);

    const { rows } = await db.pool.query<{ version: number; name: string; checksum: string }>(
      'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
    );
    expect(rows.map((row) => row.version)).toEqual([0, 1, 2, 3]);
    expect(rows[0]?.name).toBe('init');
    expect(rows[0]?.checksum).toHaveLength(64);
  });

  it('deja pgcrypto usable', async () => {
    const { rows } = await db.pool.query<{ id: string }>('SELECT gen_random_uuid()::text AS id');
    expect(rows[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('detecta la version de TimescaleDB del contenedor', async () => {
    const result = await runMigrations({ pool: db.pool });
    expect(result.timescaleVersion).toMatch(/^\d+\.\d+/);
  });

  it('es idempotente: repetirlo no aplica nada', async () => {
    const result = await runMigrations({ pool: db.pool });

    expect(result.applied).toEqual([]);
    expect(result.alreadyApplied).toEqual(['000_init.sql', '001_candles.sql', '002_ingest.sql', '003_backtests.sql']);

    const { rows } = await db.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM schema_migrations',
    );
    expect(rows[0]?.count).toBe('4');
  });
});

describe('inmutabilidad de las migraciones aplicadas', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tt-migrate-itest-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('falla con mensaje explicito si cambia el contenido de una ya aplicada', async () => {
    const file = join(dir, '900_immutable.sql');
    await writeFile(file, 'CREATE TABLE immutable_probe (id integer PRIMARY KEY);');
    await runMigrations({ pool: db.pool, dir });

    const { rows: before } = await db.pool.query<{ checksum: string }>(
      'SELECT checksum FROM schema_migrations WHERE version = 900',
    );

    await writeFile(file, 'CREATE TABLE immutable_probe (id integer PRIMARY KEY, extra text);');

    const failure = runMigrations({ pool: db.pool, dir });
    await expect(failure).rejects.toBeInstanceOf(MigrationChecksumError);
    await expect(failure).rejects.toThrow(/900_immutable\.sql/);
    await expect(failure).rejects.toThrow(/inmutables/i);

    const { rows: after } = await db.pool.query<{ checksum: string }>(
      'SELECT checksum FROM schema_migrations WHERE version = 900',
    );
    expect(after[0]?.checksum).toBe(before[0]?.checksum);

    const { rows: columns } = await db.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM information_schema.columns WHERE table_name = 'immutable_probe'",
    );
    expect(columns[0]?.count).toBe('1');
  });
});

describe('lock de concurrencia', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tt-migrate-lock-'));
    await writeFile(join(dir, '901_lock.sql'), 'CREATE TABLE lock_probe (id integer PRIMARY KEY);');
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('dos ejecuciones simultaneas no aplican la misma migracion dos veces', async () => {
    const results = await Promise.all([
      runMigrations({ pool: db.pool, dir }),
      runMigrations({ pool: db.pool, dir }),
    ]);

    const applied = results.flatMap((result) => result.applied);
    const skipped = results.flatMap((result) => result.alreadyApplied);

    expect(applied).toEqual(['901_lock.sql']);
    expect(skipped).toEqual(['901_lock.sql']);
  });
});
