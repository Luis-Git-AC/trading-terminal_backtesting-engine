import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

export const MIGRATION_LOCK_ID = 828_141_003;

const FILENAME_PATTERN = /^(\d{3,})_([a-z0-9]+(?:[_-][a-z0-9]+)*)\.sql$/;

export interface Migration {
  version: number;
  name: string;
  filename: string;
  sql: string;
  checksum: string;
}

export interface MigrationReport {
  applied: readonly string[];
  alreadyApplied: readonly string[];
  timescaleVersion: string | null;
}

export type MigrationEvent =
  | { kind: 'applied'; filename: string; durationMs: number }
  | { kind: 'skipped'; filename: string }
  | { kind: 'notice'; message: string }
  | { kind: 'warning'; message: string };

export type MigrationLogger = (event: MigrationEvent) => void;

export interface RunMigrationsOptions {
  pool: Pool;
  dir?: string;
  log?: MigrationLogger;
}

export class MigrationError extends Error {
  override readonly name: string = 'MigrationError';
}

export class MigrationChecksumError extends MigrationError {
  override readonly name = 'MigrationChecksumError';
  readonly filename: string;
  readonly expected: string;
  readonly actual: string;

  constructor(filename: string, expected: string, actual: string) {
    super(
      [
        `La migracion ${filename} ya esta aplicada pero su contenido ha cambiado.`,
        `  checksum registrado: ${expected}`,
        `  checksum actual:     ${actual}`,
        '',
        'Las migraciones son inmutables y solo hacia adelante (docs/02-DATA-MODEL.md).',
        'Revierte el fichero a su contenido original y crea una migracion nueva con el cambio.',
      ].join('\n'),
    );
    this.filename = filename;
    this.expected = expected;
    this.actual = actual;
  }
}

export function checksumOf(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

export function parseMigrationFilename(filename: string): { version: number; name: string } | null {
  const match = FILENAME_PATTERN.exec(filename);
  if (match?.[1] === undefined || match[2] === undefined) return null;
  return { version: Number.parseInt(match[1], 10), name: match[2] };
}

export async function readMigrations(dir: string = MIGRATIONS_DIR): Promise<Migration[]> {
  const entries = (await readdir(dir)).filter((entry) => entry.endsWith('.sql'));
  const byVersion = new Map<number, Migration>();

  for (const filename of entries) {
    const parsed = parseMigrationFilename(filename);
    if (parsed === null) {
      throw new MigrationError(
        `Nombre de migracion invalido: ${filename}. Se espera NNN_nombre.sql (docs/02-DATA-MODEL.md).`,
      );
    }

    const duplicate = byVersion.get(parsed.version);
    if (duplicate !== undefined) {
      throw new MigrationError(
        `Version de migracion duplicada ${parsed.version}: ${duplicate.filename} y ${filename}.`,
      );
    }

    const sql = await readFile(join(dir, filename), 'utf8');
    byVersion.set(parsed.version, {
      version: parsed.version,
      name: parsed.name,
      filename,
      sql,
      checksum: checksumOf(sql),
    });
  }

  return [...byVersion.values()].sort((a, b) => a.version - b.version);
}

async function ensureSchemaMigrations(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    integer     PRIMARY KEY,
      name       text        NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(),
      checksum   text        NOT NULL
    )
  `);
}

async function fetchApplied(client: PoolClient): Promise<Map<number, string>> {
  const { rows } = await client.query<{ version: number; checksum: string }>(
    'SELECT version, checksum FROM schema_migrations',
  );
  return new Map(rows.map((row) => [row.version, row.checksum]));
}

async function applyMigration(client: PoolClient, migration: Migration): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(migration.sql);
    await client.query(
      'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
      [migration.version, migration.name, migration.checksum],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    const reason = error instanceof Error ? error.message : String(error);
    throw new MigrationError(`La migracion ${migration.filename} fallo y se revirtio: ${reason}`, {
      cause: error,
    });
  }
}

async function detectTimescale(client: PoolClient): Promise<string | null> {
  const { rows } = await client.query<{ extversion: string }>(
    "SELECT extversion FROM pg_extension WHERE extname = 'timescaledb'",
  );
  return rows[0]?.extversion ?? null;
}

export async function runMigrations({
  pool,
  dir = MIGRATIONS_DIR,
  log = () => undefined,
}: RunMigrationsOptions): Promise<MigrationReport> {
  const migrations = await readMigrations(dir);
  const client = await pool.connect();
  const onNotice = (notice: { message?: string | undefined }): void => {
    if (notice.message !== undefined) log({ kind: 'notice', message: notice.message });
  };
  client.on('notice', onNotice);

  const applied: string[] = [];
  const alreadyApplied: string[] = [];

  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    try {
      await ensureSchemaMigrations(client);
      const known = await fetchApplied(client);

      for (const migration of migrations) {
        const recorded = known.get(migration.version);

        if (recorded !== undefined) {
          if (recorded !== migration.checksum) {
            throw new MigrationChecksumError(migration.filename, recorded, migration.checksum);
          }
          alreadyApplied.push(migration.filename);
          log({ kind: 'skipped', filename: migration.filename });
          continue;
        }

        const startedAt = Date.now();
        await applyMigration(client, migration);
        applied.push(migration.filename);
        log({ kind: 'applied', filename: migration.filename, durationMs: Date.now() - startedAt });
      }

      const timescaleVersion = await detectTimescale(client);
      if (timescaleVersion === null) {
        log({
          kind: 'warning',
          message:
            'TimescaleDB no esta instalada. candles se creara con el fallback particionado por rango (ADR-002).',
        });
      }

      return { applied, alreadyApplied, timescaleVersion };
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
    }
  } finally {
    client.off('notice', onNotice);
    client.release();
  }
}
