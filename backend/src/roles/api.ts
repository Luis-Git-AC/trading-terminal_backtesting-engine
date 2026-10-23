import { randomInt } from 'node:crypto';
import type { Server } from 'node:http';
import type { Pool } from 'pg';
import type { Redis } from 'ioredis';
import { runMigrations } from '../db/migrate.js';
import type { AppLogger } from '../observability/logger.js';
import { createApiApp, type ApiDeps } from '../api/server.js';
import { createBacktestRateLimit, type RateLimitOptions } from '../api/middleware/rate-limit.js';
import { backtestsRouter } from '../api/routes/backtests.js';
import { candlesRouter } from '../api/routes/candles.js';
import { derivativesRouter } from '../api/routes/derivatives.js';
import { eventsRouter } from '../api/routes/events.js';
import { macroRouter } from '../api/routes/macro.js';
import { marketsRouter } from '../api/routes/markets.js';
import { strategiesRouter } from '../api/routes/strategies.js';
import { streamRouter } from '../api/routes/stream.js';
import { createSseHub } from '../api/sse/hub.js';
import { createRedisCache } from '../api/services/cache.js';
import { createCandlesRepository } from '../db/repositories/candles.repo.js';
import { createDerivativesRepository } from '../db/repositories/derivatives.repo.js';
import { createEventsRepository } from '../db/repositories/events.repo.js';
import { createIngestStateRepository } from '../db/repositories/ingest-state.repo.js';
import { createMacroRepository } from '../db/repositories/macro.repo.js';
import { createRunsRepository } from '../db/repositories/runs.repo.js';
import { createBacktestQueue } from '../queue/backtest.queue.js';
import { createRedisCancelFlags } from '../queue/cancel-flags.js';
import { SEED_MAX, type Timeframe } from '@tt/shared';
import type { MarketExchangeDeps } from '../api/services/market.service.js';

export interface StartApiOptions {
  readonly pool: Pool;
  readonly redis: Redis;
  readonly queueConnection: Redis;
  readonly subscriber: Redis;
  readonly logger: AppLogger;
  readonly port: number;
  readonly webOrigin: string;
  readonly version: string;
  readonly migrate?: boolean;
  readonly ingestHealth?: ApiDeps['ingestHealth'];
  readonly sourcesHealth?: ApiDeps['sourcesHealth'];
  readonly exchanges: readonly MarketExchangeDeps[];
  readonly timeframes: readonly Timeframe[];
  readonly maxBars: number;
  readonly maxActiveRuns?: number;
  readonly rateLimit?: RateLimitOptions;
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
          logger.info(
            { migration: event.filename, durationMs: event.durationMs },
            'migracion aplicada',
          );
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

  const candles = createCandlesRepository(pool);
  const derivatives = createDerivativesRepository(pool);
  const ingestState = createIngestStateRepository(pool);
  const macro = createMacroRepository(pool);
  const events = createEventsRepository(pool);
  const runs = createRunsRepository(pool);
  const cache = createRedisCache(redis);
  const backtests = createBacktestQueue(options.queueConnection);
  const cancelFlags = createRedisCancelFlags(redis);
  const hub = createSseHub({ subscriber: options.subscriber, logger });
  const marketDeps = {
    candles,
    ingestState,
    cache,
    logger,
    exchanges: options.exchanges,
    timeframes: options.timeframes,
    now: () => Date.now(),
  };

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
    ...(options.sourcesHealth === undefined ? {} : { sourcesHealth: options.sourcesHealth }),
    registerRoutes: (router) => {
      router.use(marketsRouter(marketDeps));
      router.use(candlesRouter({ ...marketDeps, markets: marketDeps }));
      router.use(derivativesRouter({ derivatives, markets: marketDeps }));
      router.use(macroRouter({ macro, events, cache, logger, now: () => Date.now() }));
      router.use(eventsRouter({ macro, events, cache, logger, now: () => Date.now() }));
      router.use(strategiesRouter());
      router.use(
        backtestsRouter(
          {
            runs,
            candles,
            queue: backtests,
            cancelFlags,
            logger,
            markets: marketDeps,
            timeframes: options.timeframes,
            maxBars: options.maxBars,
            ...(options.maxActiveRuns === undefined
              ? {}
              : { maxActiveRuns: options.maxActiveRuns }),
            generateSeed: () => randomInt(0, SEED_MAX + 1),
          },
          { rateLimit: createBacktestRateLimit(options.rateLimit ?? {}) },
        ),
      );
      router.use(
        streamRouter({
          runs,
          hub,
          logger,
          markets: marketDeps,
          timeframes: options.timeframes,
        }),
      );
    },
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
        await backtests.close();
        options.queueConnection.disconnect();
        options.subscriber.disconnect();
        redis.disconnect();
        await pool.end();
        logger.info('api detenida');
      })();
      return stopping;
    },
  };
}
