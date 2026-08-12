import { BACKTEST_QUEUE_NAME, backtestJobSchema, type BacktestJob } from '@tt/shared';
import { Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { runMigrations } from '../db/migrate.js';
import {
  createCandlesRepository,
  type CandlesRepository,
} from '../db/repositories/candles.repo.js';
import { createRunsRepository, type RunsRepository } from '../db/repositories/runs.repo.js';
import type { AppLogger } from '../observability/logger.js';
import { createRedisCancelFlags } from '../queue/cancel-flags.js';
import { createRunEventPublisher } from '../queue/pubsub.js';
import {
  createAbortWatch,
  processBacktest,
  sanitizeMessage,
  type BacktestReport,
  type BacktestProcessorDeps,
} from '../worker/backtest.processor.js';

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 15_000;
export const DEFAULT_ABORT_GRACE_MS = 2_000;
export const DEFAULT_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

export interface StartWorkerOptions {
  readonly pool: Pool;
  readonly connection: Redis;
  readonly redis: Redis;
  readonly logger: AppLogger;
  readonly concurrency: number;
  readonly prefix?: string | undefined;
  readonly runs?: RunsRepository | undefined;
  readonly candles?: CandlesRepository | undefined;
  readonly getStrategy?: BacktestProcessorDeps['getStrategy'];
  readonly chunkBars?: number | undefined;
  readonly equityMaxPoints?: number | undefined;
  readonly progressEveryBars?: number | undefined;
  readonly cancelPollMs?: number | undefined;
  readonly exchange?: string | undefined;
  readonly migrate?: boolean;
  readonly closePool?: boolean;
  readonly signals?: readonly NodeJS.Signals[];
  readonly shutdownTimeoutMs?: number;
  readonly abortGraceMs?: number;
  readonly exit?: (code: number) => void;
}

export interface WorkerHandle {
  readonly worker: Worker<BacktestJob>;
  activeRuns(): readonly string[];
  stop(options?: { force?: boolean; reason?: string }): Promise<void>;
}

async function settleWithin(pending: Iterable<Promise<unknown>>, ms: number): Promise<void> {
  const all = Promise.allSettled([...pending]);
  await Promise.race([
    all,
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    }),
  ]);
}

export async function startWorker(options: StartWorkerOptions): Promise<WorkerHandle> {
  const { pool, connection, redis, logger } = options;
  const abortGraceMs = options.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const signals = options.signals ?? DEFAULT_SIGNALS;
  const exit =
    options.exit ??
    ((code: number): void => {
      process.exitCode = code;
    });

  if (options.migrate === true) {
    await runMigrations({ pool });
  }

  const cancelFlags = createRedisCancelFlags(redis);
  const publisher = createRunEventPublisher({
    redis,
    onError: (error) => {
      logger.warn({ err: error }, 'no se pudo publicar el evento del run, se sigue');
    },
  });

  const inflight = new Map<string, Promise<BacktestReport>>();
  const handlers = new Map<NodeJS.Signals, () => void>();

  let aborting = false;
  let stopping: Promise<void> | undefined;

  const deps: BacktestProcessorDeps = {
    runs: options.runs ?? createRunsRepository(pool),
    candles: options.candles ?? createCandlesRepository(pool),
    publisher,
    logger,
    ...(options.getStrategy === undefined ? {} : { getStrategy: options.getStrategy }),
    ...(options.exchange === undefined ? {} : { exchange: options.exchange }),
    ...(options.chunkBars === undefined ? {} : { chunkBars: options.chunkBars }),
    ...(options.equityMaxPoints === undefined
      ? {}
      : { equityMaxPoints: options.equityMaxPoints }),
    ...(options.progressEveryBars === undefined
      ? {}
      : { progressEveryBars: options.progressEveryBars }),
    createWatch: (runId: string) =>
      createAbortWatch({
        cancelFlags,
        runId,
        ...(options.cancelPollMs === undefined ? {} : { pollMs: options.cancelPollMs }),
        isStopping: () => aborting,
        onError: (error) => {
          logger.warn({ runId, err: error }, 'no se pudo leer la flag de cancelacion');
        },
      }),
  };

  const worker = new Worker<BacktestJob>(
    BACKTEST_QUEUE_NAME,
    async (job: Job<BacktestJob>) => {
      const payload = backtestJobSchema.parse(job.data);
      const task = processBacktest(deps, payload);
      inflight.set(payload.runId, task);
      try {
        const report = await task;
        return report;
      } finally {
        inflight.delete(payload.runId);
      }
    },
    {
      connection,
      concurrency: options.concurrency,
      ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    },
  );

  worker.on('failed', (job, error) => {
    const runId = job?.data.runId;
    logger.error({ runId, attemptsMade: job?.attemptsMade }, `el job de backtest fallo: ${error.message}`);

    if (job === undefined || runId === undefined) {
      return;
    }
    if (job.attemptsMade < (job.opts.attempts ?? 1)) {
      return;
    }

    void deps.runs.failRun(runId, sanitizeMessage(error)).then(
      () => {
        logger.warn({ runId }, 'el job agoto sus intentos: el run queda failed');
      },
      (repoError: unknown) => {
        logger.error({ runId, err: repoError }, 'no se pudo marcar el run como failed');
      },
    );
  });

  worker.on('error', (error) => {
    logger.error({ err: error }, 'error del worker de backtests');
  });

  await worker.waitUntilReady();

  async function stop(stopOptions: { force?: boolean; reason?: string } = {}): Promise<void> {
    stopping ??= (async () => {
      const reason = stopOptions.reason ?? 'stop';
      logger.info({ reason, force: stopOptions.force === true }, 'apagando el worker');

      for (const [signal, handler] of handlers) process.off(signal, handler);
      handlers.clear();

      if (stopOptions.force === true) {
        aborting = true;
        await settleWithin(inflight.values(), abortGraceMs);
      }

      await worker.close(stopOptions.force === true);

      if (stopOptions.force !== true) {
        await settleWithin(inflight.values(), abortGraceMs);
      }

      connection.disconnect();
      redis.disconnect();

      if (options.closePool !== false) {
        await pool.end();
      }

      logger.info({ reason }, 'worker apagado');
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
      await stop({ reason, force: true });
      if (!forced) exit(0);
    } catch (error) {
      logger.error({ reason, err: error }, 'fallo durante el apagado del worker');
      exit(1);
    } finally {
      clearTimeout(guard);
    }
  }

  for (const signal of signals) {
    const handler = (): void => {
      void shutdown(signal);
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }

  logger.info({ concurrency: options.concurrency }, 'worker de backtests arrancado');

  return {
    worker,
    activeRuns: () => [...inflight.keys()],
    stop,
  };
}
