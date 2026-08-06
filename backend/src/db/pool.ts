import { Pool } from 'pg';
import { env } from '../config/env.js';

export interface PoolSettings {
  connectionString: string;
  ssl: boolean;
  max: number;
  applicationName: string;
}

const DEFAULT_MAX = 10;
const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

export function createPool(settings: Partial<PoolSettings> = {}): Pool {
  const ssl = settings.ssl ?? env.DATABASE_SSL;

  return new Pool({
    connectionString: settings.connectionString ?? env.DATABASE_URL,
    max: settings.max ?? DEFAULT_MAX,
    application_name: settings.applicationName ?? `tt-${env.START_MODE}`,
    ...(ssl ? { ssl: { rejectUnauthorized: false } } : {}),
  });
}

let shared: Pool | undefined;
let handlersInstalled = false;

function installShutdownHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;

  for (const signal of SHUTDOWN_SIGNALS) {
    process.once(signal, () => {
      void closePool();
    });
  }
}

export function getPool(): Pool {
  if (shared === undefined) {
    shared = createPool();
    installShutdownHandlers();
  }
  return shared;
}

export async function closePool(): Promise<void> {
  const pool = shared;
  shared = undefined;
  if (pool !== undefined) {
    await pool.end();
  }
}
