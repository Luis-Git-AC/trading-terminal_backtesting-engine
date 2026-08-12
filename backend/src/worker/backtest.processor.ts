import {
  expectedCandleCount,
  type BacktestJob,
  type RunStatus,
} from '@tt/shared';
import type { CandlesRepository } from '../db/repositories/candles.repo.js';
import type { RunRecord, RunsRepository } from '../db/repositories/runs.repo.js';
import { downsampleEquity, EQUITY_MAX_POINTS } from '../engine/metrics.js';
import { round10 } from '../engine/num.js';
import { runBacktest } from '../engine/run-backtest.js';
import { PROGRESS_EVERY_BARS, type ProgressEvent } from '../engine/types.js';
import type { AppLogger } from '../observability/logger.js';
import type { CancelFlagStore } from '../queue/cancel-flags.js';
import type { RunEventPublisher } from '../queue/pubsub.js';
import { getStrategy } from '../strategies/registry.js';
import { DEFAULT_CHUNK_BARS, loadCandles } from './candle-loader.js';

export const PROGRESS_MIN_INTERVAL_MS = 200;

export const PROGRESS_PERSIST_PCT = 5;

export const DEFAULT_CANCEL_POLL_MS = 250;

export const OUTCOMES = ['completed', 'failed', 'cancelled', 'requeued', 'skipped'] as const;

export type BacktestOutcome = (typeof OUTCOMES)[number];

export type AbortReason = 'cancelled' | 'stopping';

export interface AbortWatch {
  reason(): AbortReason | null;
  stop(): void;
}

export class RunAbortedError extends Error {
  override readonly name = 'RunAbortedError';
  readonly abortReason: AbortReason;

  constructor(abortReason: AbortReason) {
    super(`Run abortado: ${abortReason}.`);
    this.abortReason = abortReason;
  }
}

export interface CancelWatchOptions {
  readonly cancelFlags: CancelFlagStore;
  readonly runId: string;
  readonly pollMs?: number;
  readonly isStopping?: () => boolean;
  readonly onError?: (error: unknown) => void;
}

export function createAbortWatch(options: CancelWatchOptions): AbortWatch {
  const isStopping = options.isStopping ?? ((): boolean => false);
  let cancelled = false;

  const timer = setInterval(() => {
    void options.cancelFlags.isRequested(options.runId).then(
      (requested) => {
        if (requested) {
          cancelled = true;
        }
      },
      (error: unknown) => {
        options.onError?.(error);
      },
    );
  }, options.pollMs ?? DEFAULT_CANCEL_POLL_MS);
  timer.unref?.();

  return {
    reason(): AbortReason | null {
      if (cancelled) return 'cancelled';
      if (isStopping()) return 'stopping';
      return null;
    },
    stop(): void {
      clearInterval(timer);
    },
  };
}

export interface BacktestProcessorDeps {
  readonly runs: RunsRepository;
  readonly candles: CandlesRepository;
  readonly publisher: RunEventPublisher;
  readonly logger: AppLogger;
  readonly createWatch: (runId: string) => AbortWatch;
  readonly exchange?: string | undefined;
  readonly chunkBars?: number | undefined;
  readonly equityMaxPoints?: number | undefined;
  readonly progressEveryBars?: number | undefined;
  readonly progressMinIntervalMs?: number | undefined;
  readonly now?: (() => number) | undefined;
  readonly getStrategy?: typeof getStrategy | undefined;
}

export interface BacktestReport {
  readonly runId: string;
  readonly outcome: BacktestOutcome;
  readonly barsLoaded: number;
  readonly trades: number;
  readonly durationMs: number;
  readonly error?: string;
}

function sanitize(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim().slice(0, 500);
}

function pctOf(barsDone: number, barsTotal: number): number {
  if (barsTotal <= 0) return 100;
  return Math.min(100, round10((barsDone / barsTotal) * 100));
}

function skip(
  deps: BacktestProcessorDeps,
  runId: string,
  status: RunStatus | 'inexistente',
  startedAt: number,
): BacktestReport {
  deps.logger.warn({ runId, status }, 'job descartado: el run no esta en cola');
  return {
    runId,
    outcome: 'skipped',
    barsLoaded: 0,
    trades: 0,
    durationMs: (deps.now ?? Date.now)() - startedAt,
  };
}

export async function processBacktest(
  deps: BacktestProcessorDeps,
  job: BacktestJob,
): Promise<BacktestReport> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const { runId } = job;

  const run = await deps.runs.getRun(runId);
  if (run === null) {
    return skip(deps, runId, 'inexistente', startedAt);
  }
  if (run.status !== 'queued') {
    return skip(deps, runId, run.status, startedAt);
  }

  const expectedBars =
    run.barsTotal ?? expectedCandleCount(run.rangeFrom, run.rangeTo, run.timeframe);

  const claimed = await deps.runs.markRunning(runId, expectedBars);
  if (!claimed) {
    const fresh = await deps.runs.getRun(runId);
    return skip(deps, runId, fresh?.status ?? 'inexistente', startedAt);
  }

  await deps.publisher.publish({
    type: 'status',
    runId,
    status: 'running',
    barsTotal: expectedBars,
  });

  const watch = deps.createWatch(runId);

  try {
    return await execute(deps, run, watch, expectedBars, startedAt);
  } catch (error) {
    if (error instanceof RunAbortedError) {
      return await abort(deps, run, error.abortReason, startedAt);
    }

    const message = sanitize(error);
    deps.logger.error({ runId, err: error }, 'el backtest fallo');
    await deps.runs.failRun(runId, message);
    await deps.publisher.publish({ type: 'error', runId, code: 'INTERNAL', message });
    await deps.publisher.publish({ type: 'done', runId, status: 'failed' });

    return {
      runId,
      outcome: 'failed',
      barsLoaded: 0,
      trades: 0,
      durationMs: now() - startedAt,
      error: message,
    };
  } finally {
    watch.stop();
  }
}

async function abort(
  deps: BacktestProcessorDeps,
  run: RunRecord,
  reason: AbortReason,
  startedAt: number,
): Promise<BacktestReport> {
  const now = deps.now ?? Date.now;

  if (reason === 'cancelled') {
    await deps.runs.cancelRun(run.id);
    await deps.publisher.publish({ type: 'done', runId: run.id, status: 'cancelled' });
    deps.logger.info({ runId: run.id }, 'run cancelado a peticion del usuario');
    return {
      runId: run.id,
      outcome: 'cancelled',
      barsLoaded: 0,
      trades: 0,
      durationMs: now() - startedAt,
    };
  }

  await deps.runs.requeueRun(run.id);
  await deps.publisher.publish({
    type: 'status',
    runId: run.id,
    status: 'queued',
    barsTotal: run.barsTotal ?? 0,
  });
  deps.logger.warn({ runId: run.id }, 'worker apagandose: el run vuelve a la cola');

  return {
    runId: run.id,
    outcome: 'requeued',
    barsLoaded: 0,
    trades: 0,
    durationMs: now() - startedAt,
  };
}

async function execute(
  deps: BacktestProcessorDeps,
  run: RunRecord,
  watch: AbortWatch,
  expectedBars: number,
  startedAt: number,
): Promise<BacktestReport> {
  const now = deps.now ?? Date.now;
  const runId = run.id;

  const throwIfAborted = (): void => {
    const reason = watch.reason();
    if (reason !== null) {
      throw new RunAbortedError(reason);
    }
  };

  throwIfAborted();

  const candles = await loadCandles({
    candles: deps.candles,
    ...(deps.exchange === undefined ? {} : { exchange: deps.exchange }),
    symbol: run.symbol,
    timeframe: run.timeframe,
    from: run.rangeFrom,
    to: run.rangeTo,
    chunkBars: deps.chunkBars ?? DEFAULT_CHUNK_BARS,
    onChunk: () => {
      throwIfAborted();
    },
  });

  if (candles.length !== expectedBars) {
    await deps.publisher.publish({
      type: 'status',
      runId,
      status: 'running',
      barsTotal: candles.length,
    });
  }

  const strategy = (deps.getStrategy ?? getStrategy)(run.strategyId);
  const minIntervalMs = deps.progressMinIntervalMs ?? PROGRESS_MIN_INTERVAL_MS;
  const writes: Promise<unknown>[] = [];

  let lastPublishAt = 0;
  let lastPersistedPct = 0;
  let lastBarsDone = 0;

  const onProgress = (progress: ProgressEvent): void => {
    lastBarsDone = progress.barsDone;
    throwIfAborted();

    const at = now();
    const pct = pctOf(progress.barsDone, progress.barsTotal);
    const elapsed = at - startedAt;
    const etaMs =
      progress.barsDone > 0 && elapsed > 0
        ? Math.round((elapsed / progress.barsDone) * (progress.barsTotal - progress.barsDone))
        : null;

    if (at - lastPublishAt >= minIntervalMs) {
      lastPublishAt = at;
      writes.push(
        deps.publisher.publish({
          type: 'progress',
          runId,
          pct,
          barsDone: progress.barsDone,
          trades: progress.trades,
          equity: String(progress.equity),
          etaMs,
        }),
      );
    }

    if (pct - lastPersistedPct >= PROGRESS_PERSIST_PCT) {
      lastPersistedPct = pct;
      writes.push(
        deps.runs.updateProgress(runId, progress.barsDone).catch((error: unknown) => {
          deps.logger.warn({ runId, err: error }, 'no se pudo persistir el progreso');
        }),
      );
    }
  };

  const result = runBacktest({
    candles,
    strategy,
    params: run.params,
    exec: run.exec,
    seed: run.seed,
    onProgress,
    progressEveryBars: deps.progressEveryBars ?? PROGRESS_EVERY_BARS,
  });

  await Promise.allSettled(writes);
  throwIfAborted();

  await deps.runs.completeRun({
    runId,
    metrics: result.metrics,
    trades: result.trades,
    equity: downsampleEquity(result.equityCurve, deps.equityMaxPoints ?? EQUITY_MAX_POINTS),
  });

  await deps.publisher.publish({ type: 'done', runId, status: 'completed' });

  const durationMs = now() - startedAt;
  deps.logger.info(
    {
      runId,
      bars: candles.length,
      trades: result.trades.length,
      rejectedSignals: result.rejectedSignals,
      lastBarsDone,
      durationMs,
    },
    'backtest completado',
  );

  return {
    runId,
    outcome: 'completed',
    barsLoaded: candles.length,
    trades: result.trades.length,
    durationMs,
  };
}
