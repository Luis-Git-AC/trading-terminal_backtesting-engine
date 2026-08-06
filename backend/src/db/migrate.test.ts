import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MIGRATIONS_DIR,
  MigrationError,
  checksumOf,
  parseMigrationFilename,
  readMigrations,
} from './migrate.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tt-migrations-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('checksumOf', () => {
  it('es estable para el mismo contenido', () => {
    expect(checksumOf('SELECT 1;')).toBe(checksumOf('SELECT 1;'));
  });

  it('cambia si cambia el contenido', () => {
    expect(checksumOf('SELECT 1;')).not.toBe(checksumOf('SELECT 2;'));
  });

  it('ignora el final de linea para no depender del checkout de Windows', () => {
    expect(checksumOf('CREATE TABLE a();\r\nSELECT 1;\r\n')).toBe(
      checksumOf('CREATE TABLE a();\nSELECT 1;\n'),
    );
  });
});

describe('parseMigrationFilename', () => {
  it('acepta el formato NNN_nombre.sql', () => {
    expect(parseMigrationFilename('000_init.sql')).toEqual({ version: 0, name: 'init' });
    expect(parseMigrationFilename('012_ingest_state.sql')).toEqual({
      version: 12,
      name: 'ingest_state',
    });
  });

  it('rechaza nombres sin prefijo numerico o mal formados', () => {
    expect(parseMigrationFilename('init.sql')).toBeNull();
    expect(parseMigrationFilename('1_init.sql')).toBeNull();
    expect(parseMigrationFilename('001-init.sql')).toBeNull();
    expect(parseMigrationFilename('001_Init.sql')).toBeNull();
  });
});

describe('readMigrations', () => {
  it('ordena por numero, no alfabeticamente', async () => {
    await writeFile(join(dir, '002_b.sql'), 'SELECT 2;');
    await writeFile(join(dir, '010_c.sql'), 'SELECT 10;');
    await writeFile(join(dir, '001_a.sql'), 'SELECT 1;');

    expect((await readMigrations(dir)).map((m) => m.version)).toEqual([1, 2, 10]);
  });

  it('ignora ficheros que no son .sql', async () => {
    await writeFile(join(dir, '001_a.sql'), 'SELECT 1;');
    await writeFile(join(dir, 'README.md'), 'no soy una migracion');

    expect(await readMigrations(dir)).toHaveLength(1);
  });

  it('falla ante un .sql con nombre invalido en vez de saltarselo', async () => {
    await writeFile(join(dir, 'init.sql'), 'SELECT 1;');

    await expect(readMigrations(dir)).rejects.toThrow(MigrationError);
  });

  it('falla si dos migraciones comparten version', async () => {
    await writeFile(join(dir, '001_a.sql'), 'SELECT 1;');
    await writeFile(join(dir, '001_b.sql'), 'SELECT 2;');

    await expect(readMigrations(dir)).rejects.toThrow(/duplicada/i);
  });

  it('lee el directorio real del proyecto y encuentra 000_init', async () => {
    const migrations = await readMigrations(MIGRATIONS_DIR);

    expect(migrations[0]?.filename).toBe('000_init.sql');
    expect(migrations[0]?.sql).toContain('pgcrypto');
  });
});
