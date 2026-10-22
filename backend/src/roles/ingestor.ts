import { schedule as cronSchedule, validate as cronValidate, type ScheduledTask } from 'node-cron';
import type { Pool } from 'pg';
import { alignTs, type Exchange, type Timeframe } from '@tt/shared';
import { createCandlesRepository } from '../db/repositories/candles.repo.js';
import { createGapsRepository } from '../db/repositories/gaps.repo.js';
import { createIngestStateRepository } from '../db/repositories/ingest-state.repo.js';
import type {
  ExchangeAdapter,
  ExchangeCandleStream,
  ExchangeDerivativesClient,
} from '../ingest/exchange/adapter.js';
import { collectDerivatives } from '../ingest/derivatives-collector.js';
import { fillGaps } from '../ingest/gap-filler.js';
import { getIngestHealth, type SeriesHealth } from '../ingest/health.js';
import { scanGaps, DEFAULT_GAP_SCAN_WINDOW_MS } from '../ingest/gap-scanner.js';
import { createLiveIngestor, type LiveIngestor } from '../ingest/live-ingestor.js';
import { reconcileSeries } from '../ingest/reconcile.js';
import type { CandleFeed } from '../ingest/backfill.js';
import type { CandlePublisher } from '../queue/pubsub.js';
import type { AppLogger } from '../observability/logger.js';

export const DEFAULT_METRICS_INTERVAL_MS = 60_000;
export const DEFAULT_RATE_WINDOW_MS = 5 * 60_000;
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 15_000;
export const DEFAULT_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

export interface IngestorSeries {
  symbol: string;
  timeframe: Timeframe;
}

export interface IngestorExchangeConfig {
  exchange: Exchange;
  adapter: ExchangeAdapter;
  feed: CandleFeed;
  wsUrl?: string | undefined;
  series: readonly IngestorSeries[];
  derivatives?: ExchangeDerivativesClient | undefined;
}

export interface IngestorOptions {
  pool: Pool;
  publisher: CandlePublisher;
  logger: AppLogger;
  exchanges: readonly IngestorExchangeConfig[];
  backfillFrom: number;
  gapScanCron?: string | undefined;
  gapScanWindowMs?: number;
  derivativesCron?: string | undefined;
  derivativesLookbackMs?: number | undefined;
  reconcilePageLimit?: number | undefined;
  reconcileMaxPages?: number | undefined;
  metricsIntervalMs?: number;
  rateWindowMs?: number;
  wsMaxConsecutiveFailures?: number | undefined;
  shutdownTimeoutMs?: number;
  signals?: readonly NodeJS.Signals[];
  wsReconnectBaseMs?: number | undefined;
  wsReconnectMaxMs?: number | undefined;
  wsStaleTimeoutMs?: number | undefined;
  wsHeartbeatIntervalMs?: number | undefined;
  wsStableResetMs?: number | undefined;
  now?: () => number;
  exit?: (code: number) => void;
}

export interface ExchangeMetrics {
  exchange: Exchange;
  socketState: string;
  reconnects: number;
  consecutiveFailures: number;
  degraded: boolean;
  openGaps: number;
  series: {
    symbol: string;
    timeframe: Timeframe;
    candlesPerMin: number;
    lastCandleTs: number | null;
  }[];
}

export interface IngestorMetrics {
  uptimeSec: number;
  rateWindowMin: number;
  openGaps: number;
  degraded: boolean;
  exchanges: ExchangeMetrics[];
}

export interface ExchangeHealth {
  exchange: Exchange;
  status: 'ok' | 'degraded';
  socketState: string;
  reconnects: number;
  consecutiveFailures: number;
  openGaps: number;
  staleSeries: number;
  series: SeriesHealth[];
}

export interface IngestorHealth {
  status: 'ok' | 'degraded';
  openGaps: number;
  staleSeries: number;
  checkedAt: number;
  exchanges: ExchangeHealth[];
}

export interface IngestorExchangeHandle {
  readonly exchange: Exchange;
  readonly stream: ExchangeCandleStream;
  readonly ingestor: LiveIngestor;
}

export interface IngestorHandle {
  readonly exchanges: readonly IngestorExchangeHandle[];
  metrics(): Promise<IngestorMetrics>;
  health(): Promise<IngestorHealth>;
  runGapCycle(): Promise<void>;
  runDerivativesCycle(): Promise<void>;
  stop(reason: string): Promise<void>;
}

interface SeriesCounter {
  symbol: string;
  timeframe: Timeframe;
  recent: { at: number; candles: number }[];
  lastCandleTs: number | null;
}

interface Runtime {
  config: IngestorExchangeConfig;
  stream: ExchangeCandleStream;
  ingestor: LiveIngestor;
  counters: Map<string, SeriesCounter>;
  reconnects: number;
  opens: number;
}

function keyOf(symbol: string, timeframe: Timeframe): string {
  return `${symbol}|${timeframe}`;
}

export async function startIngestor(options: IngestorOptions): Promise<IngestorHandle> {
  const {
    pool,
    publisher,
    logger,
    exchanges,
    now = Date.now,
    metricsIntervalMs = DEFAULT_METRICS_INTERVAL_MS,
    shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
    rateWindowMs = DEFAULT_RATE_WINDOW_MS,
    gapScanWindowMs = DEFAULT_GAP_SCAN_WINDOW_MS,
    signals = DEFAULT_SIGNALS,
    exit = (code: number): void => {
      process.exitCode = code;
    },
  } = options;

  if (exchanges.length === 0) {
    throw new RangeError('el ingestor necesita al menos un exchange configurado');
  }

  const startedAt = now();
  const state = createIngestStateRepository(pool);
  const gaps = createGapsRepository(pool);
  const candlesRepo = createCandlesRepository(pool);
  const handlers = new Map<NodeJS.Signals, () => void>();

  let stopping: Promise<void> | undefined;
  let metricsTimer: ReturnType<typeof setInterval> | undefined;
  let scanTask: ScheduledTask | undefined;
  let derivativesTask: ScheduledTask | undefined;

  const runtimes: Runtime[] = [];

  function streamOptions(config: IngestorExchangeConfig): Parameters<
    ExchangeAdapter['createCandleStream']
  >[0] {
    return {
      ...(config.wsUrl === undefined ? {} : { url: config.wsUrl }),
      ...(options.wsReconnectBaseMs === undefined
        ? {}
        : { reconnectBaseMs: options.wsReconnectBaseMs }),
      ...(options.wsReconnectMaxMs === undefined
        ? {}
        : { reconnectMaxMs: options.wsReconnectMaxMs }),
      ...(options.wsStaleTimeoutMs === undefined
        ? {}
        : { staleTimeoutMs: options.wsStaleTimeoutMs }),
      ...(options.wsMaxConsecutiveFailures === undefined
        ? {}
        : { maxConsecutiveFailures: options.wsMaxConsecutiveFailures }),
      ...(options.wsHeartbeatIntervalMs === undefined
        ? {}
        : { heartbeatIntervalMs: options.wsHeartbeatIntervalMs }),
      ...(options.wsStableResetMs === undefined ? {} : { stableResetMs: options.wsStableResetMs }),
    };
  }

  async function reconcileExchange(runtime: Runtime, trigger: string): Promise<void> {
    for (const item of runtime.config.series) {
      try {
        const report = await reconcileSeries({
          pool,
          feed: runtime.config.feed,
          exchange: runtime.config.exchange,
          symbol: item.symbol,
          timeframe: item.timeframe,
          pageLimit: options.reconcilePageLimit,
          maxPages: options.reconcileMaxPages,
          now,
        });
        logger.info(
          {
            exchange: runtime.config.exchange,
            symbol: item.symbol,
            timeframe: item.timeframe,
            trigger,
            stoppedBy: report.stoppedBy,
            missingBefore: report.missingBefore,
            upserted: report.upserted,
            gap: report.gap,
          },
          'reconciliacion',
        );
      } catch (error) {
        logger.error(
          {
            exchange: runtime.config.exchange,
            symbol: item.symbol,
            timeframe: item.timeframe,
            trigger,
            err: error,
          },
          'la reconciliacion fallo',
        );
      }
    }
  }

  async function runGapCycle(): Promise<void> {
    for (const runtime of runtimes) {
      try {
        const scan = await scanGaps({
          pool,
          series: [...runtime.config.series],
          exchange: runtime.config.exchange,
          windowMs: gapScanWindowMs,
          now,
        });
        const fill = await fillGaps({
          pool,
          feed: runtime.config.feed,
          exchange: runtime.config.exchange,
          historyWindowCandles: runtime.config.adapter.maxHistoryCandles ?? undefined,
          now,
        });
        logger.info(
          {
            exchange: runtime.config.exchange,
            found: scan.found,
            recorded: scan.recorded,
            suppressed: scan.suppressed,
            filled: fill.filled,
            noData: fill.noData,
            unrecoverable: fill.unrecoverable,
            failed: fill.failed,
          },
          'auditoria de huecos',
        );
      } catch (error) {
        logger.error(
          { exchange: runtime.config.exchange, err: error },
          'la auditoria de huecos fallo',
        );
      }
    }
  }

  async function runDerivativesCycle(): Promise<void> {
    for (const config of exchanges) {
      const client = config.derivatives;
      if (client === undefined) continue;

      try {
        const report = await collectDerivatives({
          pool,
          client,
          exchange: config.exchange,
          symbols: [...new Set(config.series.map((item) => item.symbol))],
          ...(options.derivativesLookbackMs === undefined
            ? {}
            : { lookbackMs: options.derivativesLookbackMs }),
          now,
        });

        logger.info(
          {
            exchange: config.exchange,
            funding: report.funding,
            openInterest: report.openInterest,
            failed: report.failed,
            errors: report.results.flatMap((result) =>
              result.error === null ? [] : [{ symbol: result.symbol, error: result.error }],
            ),
          },
          'derivados recogidos',
        );
      } catch (error) {
        logger.error({ exchange: config.exchange, err: error }, 'la recogida de derivados fallo');
      }
    }
  }

  for (const config of exchanges) {
    const counters = new Map<string, SeriesCounter>();

    for (const item of config.series) {
      counters.set(keyOf(item.symbol, item.timeframe), {
        symbol: item.symbol,
        timeframe: item.timeframe,
        recent: [],
        lastCandleTs: null,
      });
      await state.ensure({
        exchange: config.exchange,
        symbol: item.symbol,
        timeframe: item.timeframe,
        targetTs: alignTs(options.backfillFrom, item.timeframe),
      });
    }

    const stream = config.adapter.createCandleStream(streamOptions(config));
    const ingestor = createLiveIngestor({
      stream,
      candles: candlesRepo,
      state,
      publisher,
      series: [...config.series],
      exchange: config.exchange,
      signals: [],
    });

    const runtime: Runtime = { config, stream, ingestor, counters, reconnects: 0, opens: 0 };
    runtimes.push(runtime);

    ingestor.on((event) => {
      if (event.kind === 'flushed') {
        const counter = counters.get(keyOf(event.symbol, event.timeframe));
        if (counter !== undefined) {
          counter.recent.push({ at: now(), candles: event.candles });
          counter.lastCandleTs = event.lastTs;
        }
        logger.debug(
          {
            exchange: config.exchange,
            symbol: event.symbol,
            timeframe: event.timeframe,
            candles: event.candles,
            written: event.written,
          },
          'velas persistidas',
        );
        return;
      }

      if (event.kind === 'error') {
        logger.warn(
          { exchange: config.exchange, stage: event.stage, err: event.error },
          'fallo en la ingesta, se continua',
        );
        return;
      }

      const streamEvent = event.event;
      if (streamEvent.kind === 'rejected') {
        logger.error(
          { exchange: config.exchange, code: streamEvent.code, arg: streamEvent.arg },
          `el exchange rechazo la suscripcion: ${streamEvent.message}`,
        );
        return;
      }
      if (streamEvent.kind === 'subscribed') {
        logger.info(
          {
            exchange: config.exchange,
            symbol: streamEvent.symbol,
            timeframe: streamEvent.timeframe,
          },
          'suscripcion confirmada',
        );
        return;
      }
      if (streamEvent.kind === 'protocol') {
        logger.warn(
          { exchange: config.exchange, detail: streamEvent.detail },
          'mensaje de protocolo no reconocido',
        );
      }
    });

    stream.socket.on((event) => {
      if (event.kind === 'reconnect') {
        runtime.reconnects += 1;
        logger.warn(
          {
            exchange: config.exchange,
            attempt: event.attempt,
            delayMs: event.delayMs,
            reason: event.reason,
          },
          'reconexion del socket programada',
        );
        return;
      }
      if (event.kind === 'degraded') {
        logger.error(
          {
            exchange: config.exchange,
            consecutiveFailures: event.consecutiveFailures,
            delayMs: event.delayMs,
            reason: event.reason,
          },
          'la ingesta lleva demasiados fallos seguidos: se sigue reintentando al backoff maximo',
        );
        return;
      }
      if (event.kind === 'stale') {
        logger.warn(
          { exchange: config.exchange, idleMs: event.idleMs },
          'socket sin mensajes, se reinicia',
        );
        return;
      }
      if (event.kind === 'error') {
        logger.warn({ exchange: config.exchange, err: event.error }, 'error del socket');
        return;
      }
      if (event.kind !== 'state' || event.to !== 'open') return;

      runtime.opens += 1;
      logger.info({ exchange: config.exchange, opens: runtime.opens }, 'socket abierto');
      if (runtime.opens > 1) void reconcileExchange(runtime, 'reconexion');
    });
  }

  async function openGapsOf(runtime: Runtime): Promise<number> {
    let total = 0;
    for (const item of runtime.config.series) {
      const open = await gaps.listOpen({
        exchange: runtime.config.exchange,
        symbol: item.symbol,
        timeframe: item.timeframe,
      });
      total += open.length;
    }
    return total;
  }

  async function metrics(): Promise<IngestorMetrics> {
    const at = now();
    const since = at - rateWindowMs;
    const windowMin = Math.min(rateWindowMs, Math.max(1, at - startedAt)) / 60_000;
    const perExchange: ExchangeMetrics[] = [];

    for (const runtime of runtimes) {
      perExchange.push({
        exchange: runtime.config.exchange,
        socketState: runtime.stream.socket.state,
        reconnects: runtime.reconnects,
        consecutiveFailures: runtime.stream.socket.consecutiveFailures,
        degraded: runtime.stream.socket.degraded,
        openGaps: await openGapsOf(runtime),
        series: [...runtime.counters.values()].map((counter) => {
          counter.recent = counter.recent.filter((entry) => entry.at > since);
          const candles = counter.recent.reduce((total, entry) => total + entry.candles, 0);
          return {
            symbol: counter.symbol,
            timeframe: counter.timeframe,
            candlesPerMin: Number((candles / windowMin).toFixed(2)),
            lastCandleTs: counter.lastCandleTs,
          };
        }),
      });
    }

    return {
      uptimeSec: Math.round((at - startedAt) / 1000),
      rateWindowMin: Number((rateWindowMs / 60_000).toFixed(2)),
      openGaps: perExchange.reduce((total, item) => total + item.openGaps, 0),
      degraded: perExchange.some((item) => item.degraded),
      exchanges: perExchange,
    };
  }

  async function health(): Promise<IngestorHealth> {
    const perExchange: ExchangeHealth[] = [];
    let checkedAt = now();

    for (const runtime of runtimes) {
      const report = await getIngestHealth({
        pool,
        series: [...runtime.config.series],
        exchange: runtime.config.exchange,
        socketState: runtime.stream.socket.state,
        reconnects: runtime.reconnects,
        consecutiveFailures: runtime.stream.socket.consecutiveFailures,
        now,
      });
      checkedAt = report.checkedAt;
      perExchange.push({
        exchange: runtime.config.exchange,
        status: report.status,
        socketState: report.socketState,
        reconnects: report.reconnects,
        consecutiveFailures: report.consecutiveFailures,
        openGaps: report.openGaps,
        staleSeries: report.staleSeries,
        series: report.series,
      });
    }

    return {
      status: perExchange.every((item) => item.status === 'ok') ? 'ok' : 'degraded',
      openGaps: perExchange.reduce((total, item) => total + item.openGaps, 0),
      staleSeries: perExchange.reduce((total, item) => total + item.staleSeries, 0),
      checkedAt,
      exchanges: perExchange,
    };
  }

  async function stop(reason: string): Promise<void> {
    stopping ??= (async () => {
      logger.info({ reason }, 'apagando el ingestor');

      for (const [signal, handler] of handlers) process.off(signal, handler);
      handlers.clear();

      if (metricsTimer !== undefined) clearInterval(metricsTimer);
      metricsTimer = undefined;
      if (scanTask !== undefined) await scanTask.destroy();
      scanTask = undefined;
      if (derivativesTask !== undefined) await derivativesTask.destroy();
      derivativesTask = undefined;

      for (const runtime of runtimes) await runtime.ingestor.stop();
      await pool.end();

      logger.info({ reason }, 'ingestor apagado');
    })();

    return stopping;
  }

  async function shutdown(reason: string): Promise<void> {
    let forced = false;
    const guard = setTimeout(() => {
      forced = true;
      logger.error({ reason, shutdownTimeoutMs }, 'apagado forzado por timeout');
      exit(1);
    }, shutdownTimeoutMs);
    guard.unref?.();

    try {
      await stop(reason);
      if (!forced) exit(0);
    } catch (error) {
      logger.error({ reason, err: error }, 'fallo durante el apagado');
      exit(1);
    } finally {
      clearTimeout(guard);
    }
  }

  for (const runtime of runtimes) await reconcileExchange(runtime, 'arranque');

  for (const runtime of runtimes) runtime.ingestor.start();

  for (const signal of signals) {
    const handler = (): void => {
      void shutdown(signal);
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }

  if (metricsIntervalMs > 0) {
    metricsTimer = setInterval(() => {
      void metrics().then(
        (snapshot) => {
          logger.info(snapshot, 'metricas de ingesta');
        },
        (error: unknown) => {
          logger.error({ err: error }, 'no se pudieron calcular las metricas');
        },
      );
    }, metricsIntervalMs);
    metricsTimer.unref?.();
  }

  if (options.gapScanCron !== undefined && cronValidate(options.gapScanCron)) {
    scanTask = cronSchedule(options.gapScanCron, () => {
      void runGapCycle();
    });
    logger.info({ cron: options.gapScanCron }, 'auditoria de huecos programada');
  }

  if (
    options.derivativesCron !== undefined &&
    cronValidate(options.derivativesCron) &&
    exchanges.some((config) => config.derivatives !== undefined)
  ) {
    derivativesTask = cronSchedule(options.derivativesCron, () => {
      void runDerivativesCycle();
    });
    logger.info({ cron: options.derivativesCron }, 'recogida de derivados programada');
  }

  logger.info(
    {
      exchanges: runtimes.map((runtime) => ({
        exchange: runtime.config.exchange,
        series: runtime.config.series.map((item) => `${item.symbol} ${item.timeframe}`),
      })),
    },
    'ingestor arrancado',
  );

  return {
    exchanges: runtimes.map((runtime) => ({
      exchange: runtime.config.exchange,
      stream: runtime.stream,
      ingestor: runtime.ingestor,
    })),
    metrics,
    health,
    runGapCycle,
    runDerivativesCycle,
    stop,
  };
}
