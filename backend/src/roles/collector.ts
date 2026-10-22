import {
  COLLECTOR_QUEUE_NAME,
  collectorJobSchema,
  type CollectorJob,
} from '@tt/shared';
import { Queue, Worker, type Job, type JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { createRateLimiter, type RateLimiter } from '../ingest/rate-limiter.js';
import type { AppLogger } from '../observability/logger.js';
import type { RunnableSource, SourceRunReport } from '../sources/adapter.js';
import type { SourceRegistry } from '../sources/registry.js';
import { createSourceStateStore, type SourceStateStore } from '../sources/state.js';

export const DEFAULT_SOURCE_RPS = 2;
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 15_000;
export const DEFAULT_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { age: 86_400, count: 200 },
  // El fallido se conserva una semana: es la dead letter que se mira cuando una fuente cae.
  removeOnFail: { age: 604_800 },
};

export interface StartCollectorOptions {
  readonly pool: Pool;
  readonly connection: Redis;
  readonly redis: Redis;
  readonly logger: AppLogger;
  readonly registry: SourceRegistry;
  readonly sourceRps?: number | undefined;
  readonly prefix?: string | undefined;
  readonly concurrency?: number | undefined;
  readonly runOnStart?: boolean;
  readonly closePool?: boolean;
  readonly signals?: readonly NodeJS.Signals[];
  readonly shutdownTimeoutMs?: number;
  readonly now?: () => number;
  readonly exit?: (code: number) => void;
}

export interface CollectorHandle {
  readonly queue: Queue<CollectorJob>;
  readonly worker: Worker<CollectorJob>;
  readonly state: SourceStateStore;
  /** Dispara una fuente al momento, sin esperar al cron. Para los tests y para el arranque. */
  runSourceNow(sourceId: string): Promise<SourceRunReport>;
  stop(): Promise<void>;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function startCollector(
  options: StartCollectorOptions,
): Promise<CollectorHandle> {
  const { connection, redis, logger, registry } = options;
  const now = options.now ?? Date.now;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const signals = options.signals ?? DEFAULT_SIGNALS;
  const exit =
    options.exit ??
    ((code: number): void => {
      process.exitCode = code;
    });

  const state = createSourceStateStore(redis);
  const handlers = new Map<NodeJS.Signals, () => void>();

  // Un limitador por fuente: que FRED vaya al limite no debe frenar a EIA.
  const limiters = new Map<string, RateLimiter>(
    registry.enabled.map((source) => [
      source.id,
      createRateLimiter({ rps: options.sourceRps ?? DEFAULT_SOURCE_RPS }),
    ]),
  );

  for (const entry of registry.disabled) {
    logger.warn(
      { source: entry.source.id, missingEnv: entry.missingEnv },
      'fuente desactivada: falta su configuracion',
    );
  }

  const queue = new Queue<CollectorJob>(COLLECTOR_QUEUE_NAME, {
    connection,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
    ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
  });

  async function execute(source: RunnableSource): Promise<SourceRunReport> {
    const limiter = limiters.get(source.id) ?? createRateLimiter({ rps: DEFAULT_SOURCE_RPS });

    try {
      // `since` null: la reanudacion la lleva cada fuente contra su propia tabla, que es mas
      // preciso que un cursor global por fuente (el de derivados es por mercado).
      const report = await source.run(null, { limiter, now });
      await state.recordOk(source.id, now(), report.items);
      logger.info({ ...report }, 'fuente recogida');
      return report;
    } catch (error) {
      await state.recordError(source.id, now(), describe(error));
      throw error;
    }
  }

  const worker = new Worker<CollectorJob>(
    COLLECTOR_QUEUE_NAME,
    async (job: Job<CollectorJob>) => {
      const payload = collectorJobSchema.parse(job.data);
      const source = registry.get(payload.sourceId);

      if (source === undefined) {
        // Un job huerfano de una fuente ya desactivada no debe reintentarse eternamente.
        logger.warn({ source: payload.sourceId }, 'job de una fuente que no esta activa, se ignora');
        return { sourceId: payload.sourceId, skipped: true };
      }

      return execute(source);
    },
    {
      connection,
      concurrency: options.concurrency ?? 1,
      ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    },
  );

  worker.on('failed', (job, error) => {
    const sourceId = job?.data.sourceId;
    const attempts = job?.opts.attempts ?? 1;
    const exhausted = job !== undefined && job.attemptsMade >= attempts;

    logger.error(
      { source: sourceId, attemptsMade: job?.attemptsMade, attempts, exhausted },
      `la recogida de la fuente fallo: ${error.message}`,
    );
  });

  worker.on('error', (error) => {
    logger.error({ err: error }, 'error del worker del collector');
  });

  await worker.waitUntilReady();

  for (const source of registry.enabled) {
    await queue.upsertJobScheduler(
      source.id,
      { pattern: source.schedule },
      { name: COLLECTOR_QUEUE_NAME, data: { sourceId: source.id } },
    );
    logger.info({ source: source.id, cron: source.schedule }, 'fuente programada');
  }

  // El scheduler vive en Redis y sobrevive al proceso: sin esto, una fuente que se desactiva
  // (le quitan la clave) seguiria encolando jobs huerfanos para siempre.
  const active = new Set(registry.enabled.map((source) => source.id));
  for (const scheduler of await queue.getJobSchedulers()) {
    if (scheduler.key === undefined || active.has(scheduler.key)) continue;
    await queue.removeJobScheduler(scheduler.key);
    logger.warn({ source: scheduler.key }, 'scheduler de una fuente inactiva retirado');
  }

  let stopping: Promise<void> | undefined;

  function stop(): Promise<void> {
    stopping ??= (async () => {
      logger.info('apagando el collector');

      for (const [signal, handler] of handlers) process.off(signal, handler);
      handlers.clear();

      await worker.close();
      await queue.close();
      connection.disconnect();
      redis.disconnect();

      if (options.closePool !== false) {
        await options.pool.end();
      }

      logger.info('collector apagado');
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
      await stop();
      if (!forced) exit(0);
    } catch (error) {
      logger.error({ reason, err: error }, 'fallo durante el apagado del collector');
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

  logger.info(
    {
      enabled: registry.enabled.map((source) => source.id),
      disabled: registry.disabled.map((entry) => entry.source.id),
    },
    'collector arrancado',
  );

  if (options.runOnStart === true) {
    for (const source of registry.enabled) {
      // Secuencial y aislado: una fuente que falla al arrancar no impide las demas.
      try {
        await execute(source);
      } catch (error) {
        logger.error({ source: source.id, err: error }, 'la primera pasada de la fuente fallo');
      }
    }
  }

  return {
    queue,
    worker,
    state,

    async runSourceNow(sourceId: string): Promise<SourceRunReport> {
      const source = registry.get(sourceId);
      if (source === undefined) {
        throw new Error(`Fuente no activa: ${sourceId}`);
      }
      return execute(source);
    },

    stop,
  };
}
