import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createPool } from '../db/pool.js';

const SAFE_IDENTIFIER = /^[a-z][a-z0-9_]*$/;

export interface ScratchDatabase {
  name: string;
  connectionString: string;
  pool: Pool;
  drop(): Promise<void>;
}

export interface ScratchDatabaseOptions {
  template?: string;
  applicationName?: string;
}

function requireBaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url.length === 0) {
    throw new Error(
      'DATABASE_URL no esta definida. Copia .env.example a .env y ejecuta npm run db:up.',
    );
  }
  return url;
}

export function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

async function withAdmin<T>(baseUrl: string, fn: (admin: Pool) => Promise<T>): Promise<T> {
  const admin = new Pool({ connectionString: withDatabase(baseUrl, 'postgres'), max: 1 });
  try {
    return await fn(admin);
  } finally {
    await admin.end();
  }
}

function assertSafeIdentifier(value: string): void {
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new Error(`Identificador de base de datos inseguro: ${value}`);
  }
}

export async function createScratchDatabase(
  options: ScratchDatabaseOptions = {},
): Promise<ScratchDatabase> {
  const baseUrl = requireBaseUrl();
  const name = `tt_test_${randomUUID().replaceAll('-', '')}`;
  assertSafeIdentifier(name);

  const template = options.template;
  if (template !== undefined) assertSafeIdentifier(template);

  await withAdmin(baseUrl, (admin) =>
    admin.query(
      template === undefined
        ? `CREATE DATABASE ${name}`
        : `CREATE DATABASE ${name} TEMPLATE ${template}`,
    ),
  );

  const connectionString = withDatabase(baseUrl, name);
  const pool = createPool({
    connectionString,
    max: 4,
    applicationName: options.applicationName ?? 'tt-itest',
  });

  return {
    name,
    connectionString,
    pool,
    async drop(): Promise<void> {
      await pool.end();
      await withAdmin(baseUrl, (admin) =>
        admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`),
      );
    },
  };
}
