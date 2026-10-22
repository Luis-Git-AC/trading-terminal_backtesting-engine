import { env, exchangeConfigs } from './config/env.js';
import { resolveStartMode } from './config/start-mode.js';

const APP_VERSION = '0.1.0';
import { createPool } from './db/pool.js';
import { getAdapter } from './ingest/exchange/registry.js';
import { createLogger, type AppLogger } from './observability/logger.js';
import { createQueueConnection } from './queue/connection.js';
import { createCandlePublisher, createRedisClient } from './queue/pubsub.js';
import { startApi } from './roles/api.js';
import { startIngestor } from './roles/ingestor.js';
import { startWorker } from './roles/worker.js';

function seriesOf(symbols: readonly string[]): {
  symbol: string;
  timeframe: (typeof env.TIMEFRAMES)[number];
}[] {
  return symbols.flatMap((symbol) => env.TIMEFRAMES.map((timeframe) => ({ symbol, timeframe })));
}

async function runIngestor(logger: AppLogger): Promise<void> {
  const pool = createPool();

  const redis = createRedisClient(env.REDIS_URL, {
    enableOfflineQueue: false,
    onError: (error) => {
      logger.warn({ err: error }, 'redis no disponible, se sigue persistiendo en la base de datos');
    },
  });

  const publisher = createCandlePublisher({
    redis,
    onError: (error) => {
      logger.warn({ err: error }, 'no se pudo publicar el tick, se sigue');
    },
  });

  const exchanges = exchangeConfigs(env).map((config) => {
    const adapter = getAdapter(config.exchange);
    const feed = adapter.createRestClient({
      baseUrl: config.restUrl,
      pageLimit: Math.min(env.BACKFILL_PAGE_LIMIT, adapter.maxPageLimit),
      rps: env.BACKFILL_RPS,
      log: (event) => {
        if (event.kind === 'retry') {
          logger.warn(
            {
              exchange: config.exchange,
              attempt: event.attempt,
              delayMs: event.delayMs,
              reason: event.reason,
            },
            'reintento contra el exchange',
          );
          return;
        }
        if (event.kind === 'truncated') {
          logger.warn(
            {
              exchange: config.exchange,
              symbol: event.symbol,
              timeframe: event.timeframe,
              detail: event.detail,
            },
            'historico no disponible en el exchange',
          );
          return;
        }
        logger.warn(
          {
            exchange: config.exchange,
            symbol: event.symbol,
            timeframe: event.timeframe,
            rows: event.rows.length,
          },
          'filas descartadas al normalizar',
        );
      },
    });

    return {
      exchange: config.exchange,
      adapter,
      feed,
      wsUrl: config.wsUrl,
      series: seriesOf(config.symbols),
    };
  });

  await startIngestor({
    pool,
    publisher,
    logger,
    exchanges,
    backfillFrom: Date.parse(env.BACKFILL_FROM),
    gapScanCron: env.GAP_SCAN_CRON,
    gapScanWindowMs: env.GAP_SCAN_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    reconcilePageLimit: env.BACKFILL_PAGE_LIMIT,
    reconcileMaxPages: env.RECONCILE_MAX_PAGES,
    wsReconnectBaseMs: env.WS_RECONNECT_BASE_MS,
    wsReconnectMaxMs: env.WS_RECONNECT_MAX_MS,
    wsStaleTimeoutMs: env.WS_STALE_TIMEOUT_MS,
    wsHeartbeatIntervalMs: env.WS_HEARTBEAT_INTERVAL_MS,
    wsStableResetMs: env.WS_STABLE_RESET_MS,
    wsMaxConsecutiveFailures: env.WS_MAX_CONSECUTIVE_FAILURES,
  });
}

async function runApi(logger: AppLogger): Promise<void> {
  const pool = createPool();
  const redis = createRedisClient(env.REDIS_URL, {
    enableOfflineQueue: false,
    onError: (error) => {
      logger.warn({ err: error }, 'redis no disponible');
    },
  });

  const queueConnection = createQueueConnection(env.REDIS_URL, {
    onError: (error) => {
      logger.warn({ err: error }, 'conexion de la cola no disponible');
    },
  });

  const subscriber = createRedisClient(env.REDIS_URL, {
    onError: (error) => {
      logger.warn({ err: error }, 'conexion de suscripcion no disponible');
    },
  });

  const handle = await startApi({
    pool,
    redis,
    queueConnection,
    subscriber,
    logger,
    port: env.PORT,
    webOrigin: env.WEB_ORIGIN,
    version: APP_VERSION,
    exchanges: exchangeConfigs(env).map((config) => ({
      exchange: config.exchange,
      symbols: config.symbols,
    })),
    timeframes: env.TIMEFRAMES,
    maxBars: env.BACKTEST_MAX_BARS,
    maxActiveRuns: env.BACKTEST_MAX_ACTIVE_RUNS,
    rateLimit: {
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      max: env.RATE_LIMIT_MAX_BACKTESTS,
    },
  });

  const shutdown = (signal: NodeJS.Signals): void => {
    logger.info({ signal }, 'apagando la api');
    void handle.stop().then(() => {
      process.exit(0);
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

async function runWorker(logger: AppLogger): Promise<void> {
  const pool = createPool();
  const connection = createQueueConnection(env.REDIS_URL, {
    onError: (error) => {
      logger.warn({ err: error }, 'conexion de la cola no disponible');
    },
  });
  const redis = createRedisClient(env.REDIS_URL, {
    onError: (error) => {
      logger.warn({ err: error }, 'redis no disponible');
    },
  });

  await startWorker({
    pool,
    connection,
    redis,
    logger,
    concurrency: env.BACKTEST_CONCURRENCY,
    chunkBars: env.ENGINE_CHUNK_BARS,
    equityMaxPoints: env.EQUITY_MAX_POINTS,
    migrate: false,
  });

  if (env.INGEST_IN_WORKER) {
    logger.info('INGEST_IN_WORKER activo: el ingestor arranca dentro del worker');
    await runIngestor(logger);
  }
}

export async function main(): Promise<void> {
  const role = resolveStartMode(process.argv, env.START_MODE);
  const logger = createLogger({ role, level: env.LOG_LEVEL });

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'promesa rechazada sin manejar');
  });

  if (role === 'ingestor') {
    await runIngestor(logger);
    return;
  }

  if (role === 'api') {
    await runApi(logger);
    return;
  }

  await runWorker(logger);
}

await main();
