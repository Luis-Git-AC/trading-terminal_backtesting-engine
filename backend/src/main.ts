import { env } from './config/env.js';

const APP_VERSION = '0.1.0';
import { createPool } from './db/pool.js';
import { createBitgetRestClient } from './ingest/exchange/bitget/rest.js';
import { createLogger, type AppLogger } from './observability/logger.js';
import { createQueueConnection } from './queue/connection.js';
import { createCandlePublisher, createRedisClient } from './queue/pubsub.js';
import { startApi } from './roles/api.js';
import { startIngestor } from './roles/ingestor.js';
import { startWorker } from './roles/worker.js';

function seriesFromEnv(): { symbol: string; timeframe: (typeof env.TIMEFRAMES)[number] }[] {
  return env.SYMBOLS.flatMap((symbol) =>
    env.TIMEFRAMES.map((timeframe) => ({ symbol, timeframe })),
  );
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

  const feed = createBitgetRestClient({
    baseUrl: env.EXCHANGE_REST_URL,
    pageLimit: env.BACKFILL_PAGE_LIMIT,
    rps: env.BACKFILL_RPS,
    log: (event) => {
      if (event.kind === 'retry') {
        logger.warn(
          { attempt: event.attempt, delayMs: event.delayMs, reason: event.reason },
          'reintento contra el exchange',
        );
        return;
      }
      logger.warn(
        { symbol: event.symbol, timeframe: event.timeframe, rows: event.rows.length },
        'filas descartadas al normalizar',
      );
    },
  });

  await startIngestor({
    pool,
    feed,
    publisher,
    logger,
    series: seriesFromEnv(),
    exchange: env.EXCHANGE,
    wsUrl: env.EXCHANGE_WS_URL,
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

  const handle = await startApi({
    pool,
    redis,
    queueConnection,
    logger,
    port: env.PORT,
    webOrigin: env.WEB_ORIGIN,
    version: APP_VERSION,
    exchange: env.EXCHANGE,
    symbols: env.SYMBOLS,
    timeframes: env.TIMEFRAMES,
    maxBars: env.BACKTEST_MAX_BARS,
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
    exchange: env.EXCHANGE,
    migrate: false,
  });

  if (env.INGEST_IN_WORKER) {
    logger.info('INGEST_IN_WORKER activo: el ingestor arranca dentro del worker');
    await runIngestor(logger);
  }
}

export async function main(): Promise<void> {
  const logger = createLogger({ role: env.START_MODE, level: env.LOG_LEVEL });

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'promesa rechazada sin manejar');
  });

  if (env.START_MODE === 'ingestor') {
    await runIngestor(logger);
    return;
  }

  if (env.START_MODE === 'api') {
    await runApi(logger);
    return;
  }

  await runWorker(logger);
}

await main();
