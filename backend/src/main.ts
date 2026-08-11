import { env } from './config/env.js';
import { createPool } from './db/pool.js';
import { createBitgetRestClient } from './ingest/exchange/bitget/rest.js';
import { createLogger, type AppLogger } from './observability/logger.js';
import { createCandlePublisher, createRedisClient } from './queue/pubsub.js';
import { startIngestor } from './roles/ingestor.js';

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

export async function main(): Promise<void> {
  const logger = createLogger({ role: env.START_MODE, level: env.LOG_LEVEL });

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'promesa rechazada sin manejar');
  });

  if (env.START_MODE === 'ingestor') {
    await runIngestor(logger);
    return;
  }

  logger.error(
    { startMode: env.START_MODE },
    env.START_MODE === 'api'
      ? 'el rol api todavia no esta implementado: es F4-T1'
      : 'el rol worker todavia no esta implementado: es F4-T6',
  );
  process.exitCode = 1;
}

await main();
