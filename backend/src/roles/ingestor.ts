import { schedule as cronSchedule, validate as cronValidate, type ScheduledTask } from 'node-cron';
import type { Pool } from 'pg';
import { alignTs, type Timeframe } from '@tt/shared';
import { createCandlesRepository } from '../db/repositories/candles.repo.js';
import { createGapsRepository } from '../db/repositories/gaps.repo.js';
import { createIngestStateRepository } from '../db/repositories/ingest-state.repo.js';
import { createBitgetCandleStream, type BitgetCandleStream } from '../ingest/exchange/bitget/ws.js';
import { fillGaps } from '../ingest/gap-filler.js';
import { getIngestHealth, type IngestHealth } from '../ingest/health.js';
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

export interface IngestorOptions {
  pool: Pool;
  feed: CandleFeed;
  publisher: CandlePublisher;
  logger: AppLogger;
  series: readonly IngestorSeries[];
  exchange?: string | undefined;
  wsUrl?: string | undefined;
  backfillFrom: number;
  gapScanCron?: string | undefined;
  gapScanWindowMs?: number;
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
  now?: () => number;
  exit?: (code: number) => void;
}

export interface IngestorMetrics {
  uptimeSec: number;
  socketState: string;
  reconnects: number;
  consecutiveFailures: number;
  degraded: boolean;
  openGaps: number;
  rateWindowMin: number;
  series: { symbol: string; timeframe: Timeframe; candlesPerMin: number; lastCandleTs: number | null }[];
}

export interface IngestorHandle {
  readonly stream: BitgetCandleStream;
  readonly ingestor: LiveIngestor;
  metrics(): Promise<IngestorMetrics>;
  health(): Promise<IngestHealth>;
  runGapCycle(): Promise<void>;
  stop(reason: string): Promise<void>;
}

interface SeriesCounter {
  symbol: string;
  timeframe: Timeframe;
  recent: { at: number; candles: number }[];
  lastCandleTs: number | null;
}

function keyOf(symbol: string, timeframe: Timeframe): string {
  return `${symbol}|${timeframe}`;
}

export async function startIngestor(options: IngestorOptions): Promise<IngestorHandle> {
  const {
    pool,
    feed,
    publisher,
    logger,
    series,
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

  const startedAt = now();
  const state = createIngestStateRepository(pool);
  const gaps = createGapsRepository(pool);
  const counters = new Map<string, SeriesCounter>();
  const handlers = new Map<NodeJS.Signals, () => void>();

  let reconnects = 0;
  let stopping: Promise<void> | undefined;
  let metricsTimer: ReturnType<typeof setInterval> | undefined;
  let scanTask: ScheduledTask | undefined;
  let opens = 0;

  for (const item of series) {
    counters.set(keyOf(item.symbol, item.timeframe), {
      symbol: item.symbol,
      timeframe: item.timeframe,
      recent: [],
      lastCandleTs: null,
    });
    await state.ensure({
      exchange: options.exchange,
      symbol: item.symbol,
      timeframe: item.timeframe,
      targetTs: alignTs(options.backfillFrom, item.timeframe),
    });
  }

  const stream = createBitgetCandleStream({
    ...(options.wsUrl === undefined ? {} : { url: options.wsUrl }),
    ...(options.wsReconnectBaseMs === undefined
      ? {}
      : { reconnectBaseMs: options.wsReconnectBaseMs }),
    ...(options.wsReconnectMaxMs === undefined ? {} : { reconnectMaxMs: options.wsReconnectMaxMs }),
    ...(options.wsStaleTimeoutMs === undefined ? {} : { staleTimeoutMs: options.wsStaleTimeoutMs }),
    ...(options.wsMaxConsecutiveFailures === undefined
      ? {}
      : { maxConsecutiveFailures: options.wsMaxConsecutiveFailures }),
  });

  const ingestor = createLiveIngestor({
    stream,
    candles: createCandlesRepository(pool),
    state,
    publisher,
    series: [...series],
    exchange: options.exchange,
    signals: [],
  });

  async function reconcileAll(trigger: string): Promise<void> {
    for (const item of series) {
      try {
        const report = await reconcileSeries({
          pool,
          feed,
          exchange: options.exchange,
          symbol: item.symbol,
          timeframe: item.timeframe,
          pageLimit: options.reconcilePageLimit,
          maxPages: options.reconcileMaxPages,
          now,
        });
        logger.info(
          {
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
          { symbol: item.symbol, timeframe: item.timeframe, trigger, err: error },
          'la reconciliacion fallo',
        );
      }
    }
  }

  async function runGapCycle(): Promise<void> {
    try {
      const scan = await scanGaps({
        pool,
        series: [...series],
        exchange: options.exchange,
        windowMs: gapScanWindowMs,
        now,
      });
      const fill = await fillGaps({
        pool,
        feed,
        exchange: options.exchange,
        now,
      });
      logger.info(
        {
          found: scan.found,
          recorded: scan.recorded,
          suppressed: scan.suppressed,
          filled: fill.filled,
          noData: fill.noData,
          failed: fill.failed,
        },
        'auditoria de huecos',
      );
    } catch (error) {
      logger.error({ err: error }, 'la auditoria de huecos fallo');
    }
  }

  ingestor.on((event) => {
    if (event.kind === 'flushed') {
      const counter = counters.get(keyOf(event.symbol, event.timeframe));
      if (counter !== undefined) {
        counter.recent.push({ at: now(), candles: event.candles });
        counter.lastCandleTs = event.lastTs;
      }
      logger.debug(
        {
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
      logger.warn({ stage: event.stage, err: event.error }, 'fallo en la ingesta, se continua');
      return;
    }

    const streamEvent = event.event;
    if (streamEvent.kind === 'rejected') {
      logger.error(
        { code: streamEvent.code, arg: streamEvent.arg },
        `el exchange rechazo la suscripcion: ${streamEvent.message}`,
      );
      return;
    }
    if (streamEvent.kind === 'subscribed') {
      logger.info(
        { symbol: streamEvent.symbol, timeframe: streamEvent.timeframe },
        'suscripcion confirmada',
      );
      return;
    }
    if (streamEvent.kind === 'protocol') {
      logger.warn({ detail: streamEvent.detail }, 'mensaje de protocolo no reconocido');
    }
  });

  stream.socket.on((event) => {
    if (event.kind === 'reconnect') {
      reconnects += 1;
      logger.warn(
        { attempt: event.attempt, delayMs: event.delayMs, reason: event.reason },
        'reconexion del socket programada',
      );
      return;
    }
    if (event.kind === 'degraded') {
      logger.error(
        {
          consecutiveFailures: event.consecutiveFailures,
          delayMs: event.delayMs,
          reason: event.reason,
        },
        'la ingesta lleva demasiados fallos seguidos: se sigue reintentando al backoff maximo',
      );
      return;
    }
    if (event.kind === 'stale') {
      logger.warn({ idleMs: event.idleMs }, 'socket sin mensajes, se reinicia');
      return;
    }
    if (event.kind === 'error') {
      logger.warn({ err: event.error }, 'error del socket');
      return;
    }
    if (event.kind !== 'state' || event.to !== 'open') return;

    opens += 1;
    logger.info({ opens }, 'socket abierto');
    if (opens > 1) void reconcileAll('reconexion');
  });

  async function metrics(): Promise<IngestorMetrics> {
    let openGaps = 0;
    for (const item of series) {
      const open = await gaps.listOpen({
        exchange: options.exchange,
        symbol: item.symbol,
        timeframe: item.timeframe,
      });
      openGaps += open.length;
    }

    const at = now();
    const since = at - rateWindowMs;
    const windowMin = Math.min(rateWindowMs, Math.max(1, at - startedAt)) / 60_000;

    return {
      uptimeSec: Math.round((at - startedAt) / 1000),
      socketState: stream.socket.state,
      reconnects,
      consecutiveFailures: stream.socket.consecutiveFailures,
      degraded: stream.socket.degraded,
      openGaps,
      rateWindowMin: Number((rateWindowMs / 60_000).toFixed(2)),
      series: [...counters.values()].map((counter) => {
        counter.recent = counter.recent.filter((entry) => entry.at > since);
        const candles = counter.recent.reduce((total, entry) => total + entry.candles, 0);
        return {
          symbol: counter.symbol,
          timeframe: counter.timeframe,
          candlesPerMin: Number((candles / windowMin).toFixed(2)),
          lastCandleTs: counter.lastCandleTs,
        };
      }),
    };
  }

  function health(): Promise<IngestHealth> {
    return getIngestHealth({
      pool,
      series: [...series],
      exchange: options.exchange,
      socketState: stream.socket.state,
      reconnects,
      consecutiveFailures: stream.socket.consecutiveFailures,
      now,
    });
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

      await ingestor.stop();
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

  await reconcileAll('arranque');

  ingestor.start();

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

  logger.info(
    { series: series.map((item) => `${item.symbol} ${item.timeframe}`) },
    'ingestor arrancado',
  );

  return { stream, ingestor, metrics, health, runGapCycle, stop };
}
