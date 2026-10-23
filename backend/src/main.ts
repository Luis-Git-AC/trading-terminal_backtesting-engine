import { env, exchangeConfigs } from './config/env.js';
import { resolveStartMode } from './config/start-mode.js';

const APP_VERSION = '0.1.0';
import { createPool } from './db/pool.js';
import { getAdapter } from './ingest/exchange/registry.js';
import { createLogger, type AppLogger } from './observability/logger.js';
import { createQueueConnection } from './queue/connection.js';
import { createCandlePublisher, createRedisClient } from './queue/pubsub.js';
import { createTransformersEmbedder } from './brain/embeddings/embedder.js';
import { startApi } from './roles/api.js';
import { startBrain } from './roles/brain.js';
import { startCollector } from './roles/collector.js';
import { startMcp } from './roles/mcp.js';
import { startIngestor } from './roles/ingestor.js';
import { startWorker } from './roles/worker.js';
import { toRunnable, type RunnableSource } from './sources/adapter.js';
import {
  DERIVATIVES_SOURCE_ID,
  createDerivativesSource,
  type DerivativesMarket,
} from './sources/derivatives.source.js';
import {
  COINGECKO_SOURCE_ID,
  createCoingeckoClient,
  createCoingeckoSource,
} from './sources/coingecko/coingecko.source.js';
import {
  createDefillamaClient,
  createDefillamaSource,
  DEFILLAMA_SOURCE_ID,
} from './sources/defillama/defillama.source.js';
import { createCftcClient } from './sources/cftc/client.js';
import { createCftcSource } from './sources/cftc/cftc.source.js';
import { CFTC_SOURCE_ID } from './sources/cftc/types.js';
import { createEiaClient } from './sources/eia/client.js';
import { createEiaSource } from './sources/eia/eia.source.js';
import { EIA_SOURCE_ID } from './sources/eia/types.js';
import { createFredClient } from './sources/fred/client.js';
import { createFredSource } from './sources/fred/fred.source.js';
import { FRED_SOURCE_ID } from './sources/fred/types.js';
import { buildSourceRegistry } from './sources/registry.js';
import { createRssSource, RSS_SOURCE_ID } from './sources/rss/rss.source.js';
import { createSourceStateStore } from './sources/state.js';

/** Las fuentes cuyo estado refleja /api/health. Crece con cada fuente nueva de la fase 9. */
const COLLECTOR_SOURCE_IDS = [
  DERIVATIVES_SOURCE_ID,
  FRED_SOURCE_ID,
  EIA_SOURCE_ID,
  CFTC_SOURCE_ID,
  DEFILLAMA_SOURCE_ID,
  COINGECKO_SOURCE_ID,
] as const;

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

async function runCollector(logger: AppLogger): Promise<void> {
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

  const markets: DerivativesMarket[] = exchangeConfigs(env).flatMap((config) => {
    const client = getAdapter(config.exchange).createDerivativesClient?.({
      baseUrl: config.restUrl,
      rps: env.BACKFILL_RPS,
    });
    if (client === undefined) return [];
    return config.symbols.map((symbol) => ({ exchange: config.exchange, symbol, client }));
  });

  const candidates: RunnableSource[] = [];

  if (markets.length > 0) {
    candidates.push(
      toRunnable(
        createDerivativesSource({
          pool,
          markets,
          schedule: env.DERIVATIVES_CRON,
          lookbackMs: env.DERIVATIVES_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
          onMarketError: (market, error) => {
            logger.warn(
              { exchange: market.exchange, symbol: market.symbol, err: error },
              'un mercado de derivados fallo, se sigue con los demas',
            );
          },
        }),
      ),
    );
  }

  // La clave puede faltar: el candidato se construye igual y es el registro el que lo desactiva
  // con su aviso, que es el camino que ya prueba el itest del collector.
  candidates.push(
    toRunnable(
      createFredSource({
        pool,
        client: createFredClient({
          apiKey: env.FRED_API_KEY ?? '',
          baseUrl: env.FRED_BASE_URL,
          fetch: (url) => globalThis.fetch(url),
        }),
        seriesIds: env.FRED_SERIES,
        schedule: env.FRED_CRON,
        observationStart: env.FRED_OBSERVATION_START,
        onDiscard: (discard) => {
          logger.warn({ ...discard }, 'observacion del FRED descartada');
        },
      }),
    ),
  );

  candidates.push(
    toRunnable(
      createEiaSource({
        pool,
        client: createEiaClient({
          apiKey: env.EIA_API_KEY ?? '',
          baseUrl: env.EIA_BASE_URL,
          fetch: (url) => globalThis.fetch(url),
        }),
        seriesIds: env.EIA_SERIES,
        schedule: env.EIA_CRON,
        start: env.EIA_START,
        onDiscard: (discard) => {
          logger.warn({ ...discard }, 'inventario de la EIA descartado');
        },
      }),
    ),
  );

  candidates.push(
    toRunnable(
      createCftcSource({
        pool,
        client: createCftcClient({
          url: env.CFTC_URL,
          fetch: async (url) => {
            const response = await globalThis.fetch(url);
            return { status: response.status, body: response.body };
          },
        }),
        schedule: env.CFTC_CRON,
      }),
    ),
  );

  candidates.push(
    toRunnable(
      createDefillamaSource({
        pool,
        client: createDefillamaClient({
          tvlBaseUrl: env.DEFILLAMA_TVL_URL,
          stablecoinsBaseUrl: env.DEFILLAMA_STABLECOINS_URL,
          fetch: (url) => globalThis.fetch(url),
        }),
        schedule: env.DEFILLAMA_CRON,
        from: Date.parse(`${env.DEFILLAMA_FROM}T00:00:00Z`),
      }),
    ),
    toRunnable(
      createCoingeckoSource({
        pool,
        client: createCoingeckoClient({
          baseUrl: env.COINGECKO_BASE_URL,
          fetch: (url) => globalThis.fetch(url),
          onRateLimited: (detail) => {
            logger.warn({ source: COINGECKO_SOURCE_ID, detail }, 'CoinGecko al limite de peticiones');
          },
        }),
        schedule: env.COINGECKO_CRON,
        rps: env.COINGECKO_RPS,
      }),
    ),
    toRunnable(
      createRssSource({
        pool,
        fetch: async (url) => {
          const response = await globalThis.fetch(url);
          return { status: response.status, text: () => response.text() };
        },
        schedule: env.RSS_CRON,
        onDiscard: (detail) => {
          logger.warn({ source: RSS_SOURCE_ID, detail }, 'documento o feed RSS descartado');
        },
      }),
    ),
  );

  await startCollector({
    pool,
    connection,
    redis,
    logger,
    registry: buildSourceRegistry({ candidates, env: process.env }),
    sourceRps: env.COLLECTOR_SOURCE_RPS,
    concurrency: env.COLLECTOR_CONCURRENCY,
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
    sourcesHealth: () => createSourceStateStore(redis).read(COLLECTOR_SOURCE_IDS),
    timeframes: env.TIMEFRAMES,
    maxBars: env.BACKTEST_MAX_BARS,
    maxActiveRuns: env.BACKTEST_MAX_ACTIVE_RUNS,
    // El mismo modelo que usa `brain`: una consulta vectorizada con otro modelo no se puede
    // comparar con los vectores guardados. La carga es perezosa, asi que el API no paga nada
    // hasta la primera busqueda.
    embedder: createTransformersEmbedder({ model: env.BRAIN_MODEL }),
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

async function runBrain(logger: AppLogger): Promise<void> {
  const pool = createPool();
  const connection = createQueueConnection(env.REDIS_URL, {
    onError: (error) => {
      logger.warn({ err: error }, 'conexion de la cola no disponible');
    },
  });

  const handle = await startBrain({
    pool,
    connection,
    logger,
    embedder: createTransformersEmbedder({ model: env.BRAIN_MODEL }),
    scanCron: env.BRAIN_SCAN_CRON,
    concurrency: env.BRAIN_CONCURRENCY,
    scanLimit: env.BRAIN_SCAN_LIMIT,
    exportCron: env.OBSIDIAN_EXPORT_CRON,
    ...(env.OBSIDIAN_VAULT_PATH === undefined ? {} : { vaultPath: env.OBSIDIAN_VAULT_PATH }),
  });

  // Primer barrido al arrancar: lo que entro mientras brain estaba apagado no espera al cron.
  await handle.scanNow();
  await handle.exportNow();
}

async function runMcp(): Promise<void> {
  // El log va a stderr a la fuerza: stdout es el canal JSON-RPC del transporte stdio y una sola
  // linea de log ahi rompe la sesion con el cliente.
  const logger = createLogger({ role: 'mcp', level: env.LOG_LEVEL, destination: process.stderr });

  await startMcp({
    pool: createPool(),
    logger,
    embedder: createTransformersEmbedder({ model: env.BRAIN_MODEL }),
    ...(env.OBSIDIAN_VAULT_PATH === undefined ? {} : { vaultPath: env.OBSIDIAN_VAULT_PATH }),
  });
}

export async function main(): Promise<void> {
  const role = resolveStartMode(process.argv, env.START_MODE);

  if (role === 'mcp') {
    await runMcp();
    return;
  }

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

  if (role === 'collector') {
    await runCollector(logger);
    return;
  }

  if (role === 'brain') {
    await runBrain(logger);
    return;
  }

  await runWorker(logger);
}

await main();
