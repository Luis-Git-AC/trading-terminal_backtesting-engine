import type { Server } from 'node:http';
import type { Pool } from 'pg';
import type { Redis } from 'ioredis';
import { runMigrations } from '../db/migrate.js';
import type { AppLogger } from '../observability/logger.js';
import { createApiApp, type ApiDeps } from '../api/server.js';

export interface StartApiOptions {
  readonly pool: Pool;
  readonly redis: Redis;
  readonly logger: AppLogger;
  readonly port: number;
  readonly webOrigin: string;
  readonly version: string;
  readonly migrate?: boolean;
  readonly ingestHealth?: ApiDeps['ingestHealth'];
}

export interface ApiHandle {
  readonly server: Server;
  readonly port: number;
  stop(): Promise<void>;
}

export async function startApi(options: StartApiOptions): Promise<ApiHandle> {
  const { pool, redis, logger, port } = options;

  if (options.migrate !== false) {
    const report = await runMigrations({
      pool,
      log: (event) => {
        if (event.kind === 'applied') {
          logger.info({ migration: event.filename, durationMs: event.durationMs }, 'migracion aplicada');
        } else if (event.kind === 'warning') {
          logger.warn({ message: event.message }, 'aviso de migracion');
        }
      },
    });
    logger.info(
      {
        applied: report.applied.length,
        alreadyApplied: report.alreadyApplied.length,
        timescale: report.timescaleVersion,
      },
      'migraciones al dia',
    );
  }

  const startedAt = Date.now();

  const app = createApiApp({
    logger,
    webOrigin: options.webOrigin,
    version: options.version,
    uptimeSec: () => Math.round((Date.now() - startedAt) / 1000),
    checkDb: async () => {
      await pool.query('SELECT 1');
    },
    checkRedis: async () => {
      await redis.ping();
    },
    ...(options.ingestHealth === undefined ? {} : { ingestHealth: options.ingestHealth }),
  });

  const server = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(port, () => {
      resolve(listening);
    });
    listening.once('error', reject);
  });

  logger.info({ port }, 'api escuchando');

  let stopping: Promise<void> | null = null;

  return {
    server,
    port,
    stop(): Promise<void> {
      stopping ??= (async () => {
        await new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        });
        redis.disconnect();
        await pool.end();
        logger.info('api detenida');
      })();
      return stopping;
    },
  };
}
