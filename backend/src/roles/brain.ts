import { BRAIN_QUEUE_NAME, brainJobSchema, type BrainJob } from '@tt/shared';
import { Queue, Worker, type Job, type JobsOptions } from 'bullmq';
import { schedule as cronSchedule, validate as cronValidate, type ScheduledTask } from 'node-cron';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { chunkDocument } from '../brain/embeddings/chunk.js';
import { EmbedderUnavailableError, type Embedder } from '../brain/embeddings/embedder.js';
import {
  createDocumentsRepository,
  type DocumentsRepository,
} from '../db/repositories/documents.repo.js';
import {
  createEmbeddingsRepository,
  type EmbeddingsRepository,
} from '../db/repositories/embeddings.repo.js';
import { createEventsRepository, type EventsRepository } from '../db/repositories/events.repo.js';
import { createNotesRepository, type NotesRepository } from '../db/repositories/notes.repo.js';
import { exportVault } from '../brain/export/obsidian-export.js';
import type { ExportReport } from '../brain/export/obsidian.js';
import type { AppLogger } from '../observability/logger.js';
import { DEFAULT_SHUTDOWN_TIMEOUT_MS, DEFAULT_SIGNALS } from './collector.js';

export const DEFAULT_SCAN_LIMIT = 50;

export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  // El modelo come CPU: si falla por carga, reintentar enseguida solo empeora la cola.
  backoff: { type: 'exponential', delay: 10_000 },
  removeOnComplete: { age: 3_600, count: 500 },
  removeOnFail: { age: 604_800 },
};

/** El apagado interrumpe el job a proposito para que BullMQ lo reintente desde cero. */
export class BrainShuttingDownError extends Error {
  override readonly name = 'BrainShuttingDownError';
}

export interface StartBrainOptions {
  readonly pool: Pool;
  readonly connection: Redis;
  readonly logger: AppLogger;
  readonly embedder: Embedder;
  readonly scanCron: string;
  readonly exportCron?: string | undefined;
  /** Sin ruta el export queda desactivado con un aviso; `brain` funciona igual. */
  readonly vaultPath?: string | undefined;
  readonly concurrency?: number | undefined;
  readonly scanLimit?: number | undefined;
  readonly prefix?: string | undefined;
  readonly documentsRepo?: DocumentsRepository | undefined;
  readonly embeddingsRepo?: EmbeddingsRepository | undefined;
  readonly eventsRepo?: EventsRepository | undefined;
  readonly notesRepo?: NotesRepository | undefined;
  readonly closePool?: boolean;
  readonly signals?: readonly NodeJS.Signals[];
  readonly shutdownTimeoutMs?: number;
  readonly exit?: (code: number) => void;
}

export interface BrainHandle {
  readonly queue: Queue<BrainJob>;
  readonly worker: Worker<BrainJob> | null;
  /** `false` cuando falta `pgvector`: el rol vive, pero no embebe (busqueda solo full-text). */
  readonly embeddingsEnabled: boolean;
  /** Encola los documentos que aun no tienen embeddings. Devuelve cuantos encolo. */
  scanNow(): Promise<number>;
  /** Reconstruye la vista del vault de Obsidian. Sin `vaultPath` no escribe nada. */
  exportNow(): Promise<ExportReport>;
  stop(): Promise<void>;
}

export async function startBrain(options: StartBrainOptions): Promise<BrainHandle> {
  const { connection, logger } = options;
  const documentsRepo = options.documentsRepo ?? createDocumentsRepository(options.pool);
  const embeddingsRepo = options.embeddingsRepo ?? createEmbeddingsRepository(options.pool);
  const scanLimit = options.scanLimit ?? DEFAULT_SCAN_LIMIT;
  const eventsRepo = options.eventsRepo ?? createEventsRepository(options.pool);
  const notesRepo = options.notesRepo ?? createNotesRepository(options.pool);
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const signals = options.signals ?? DEFAULT_SIGNALS;
  const exit =
    options.exit ??
    ((code: number): void => {
      process.exitCode = code;
    });

  const prefixOption = options.prefix === undefined ? {} : { prefix: options.prefix };
  const queue = new Queue<BrainJob>(BRAIN_QUEUE_NAME, {
    connection,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
    ...prefixOption,
  });

  // Mismo patron que ADR-002: se comprueba la capacidad y, si falta, se degrada con un aviso
  // claro en vez de reventar el arranque.
  const embeddingsEnabled = await embeddingsRepo.isAvailable();
  if (!embeddingsEnabled) {
    logger.warn(
      { model: options.embedder.model },
      'pgvector no disponible (migracion 009): brain arranca sin embeddings y la busqueda sera solo full-text',
    );
  }

  let shuttingDown = false;
  const handlers = new Map<NodeJS.Signals, () => void>();

  async function embedDocument(documentId: string): Promise<number> {
    const [document] = await documentsRepo.getDocumentsByIds([documentId]);
    if (document === undefined) {
      logger.warn({ documentId }, 'documento ya borrado, no hay nada que embeber');
      return 0;
    }

    const chunks = chunkDocument(document);
    if (chunks.length === 0) return 0;

    const vectors = await options.embedder.embed(chunks);
    if (shuttingDown) {
      throw new BrainShuttingDownError(
        `apagado a mitad del documento ${documentId}: el job se reintenta entero`,
      );
    }

    for (const [index, vector] of vectors.entries()) {
      if (vector.length !== options.embedder.dimensions) {
        throw new Error(
          `el trozo ${String(index)} salio con ${String(vector.length)} dimensiones y la columna espera ${String(options.embedder.dimensions)}`,
        );
      }
    }

    return await embeddingsRepo.replaceEmbeddings({
      documentId,
      model: options.embedder.model,
      chunks: chunks.map((chunkText, chunkIdx) => ({
        chunkIdx,
        chunkText,
        embedding: vectors[chunkIdx] ?? [],
      })),
    });
  }

  const worker = embeddingsEnabled
    ? new Worker<BrainJob>(
        BRAIN_QUEUE_NAME,
        async (job: Job<BrainJob>) => {
          const { documentId } = brainJobSchema.parse(job.data);
          const written = await embedDocument(documentId);
          logger.info({ documentId, chunks: written }, 'documento embebido');
          return { documentId, chunks: written };
        },
        { connection, concurrency: options.concurrency ?? 1, ...prefixOption },
      )
    : null;

  worker?.on('failed', (job, error) => {
    const attempts = job?.opts.attempts ?? 1;
    const level = error instanceof EmbedderUnavailableError ? 'warn' : 'error';
    logger[level](
      {
        documentId: job?.data.documentId,
        attemptsMade: job?.attemptsMade,
        attempts,
        exhausted: job !== undefined && job.attemptsMade >= attempts,
      },
      `el embedding fallo: ${error.message}`,
    );
  });

  worker?.on('error', (error) => {
    logger.error({ err: error }, 'error del worker de brain');
  });

  await worker?.waitUntilReady();

  async function scanNow(): Promise<number> {
    if (!embeddingsEnabled) return 0;

    const pending = await embeddingsRepo.pendingDocuments({
      model: options.embedder.model,
      limit: scanLimit,
    });

    for (const documentId of pending) {
      // `jobId` por documento y modelo: un documento no se encola dos veces mientras espera. El
      // nombre del modelo lleva barras y BullMQ no admite `:` en el id, de ahi el saneado.
      await queue.add(
        BRAIN_QUEUE_NAME,
        { documentId },
        { jobId: `${documentId}-${options.embedder.model.replace(/[^a-zA-Z0-9]+/gu, '-')}` },
      );
    }

    if (pending.length > 0)
      logger.info({ encolados: pending.length }, 'documentos pendientes encolados');
    return pending.length;
  }

  // El barrido es un cron local y no un job repeatable de BullMQ: el job repeatable tendria que
  // llevar un `documentId` falso para cumplir el esquema de la cola, y lo que hace el barrido es
  // justo encolar esos jobs. Asi tambien recoge los documentos que entraron con brain apagado.
  let scanTask: ScheduledTask | undefined;
  if (embeddingsEnabled && cronValidate(options.scanCron)) {
    scanTask = cronSchedule(options.scanCron, () => {
      void scanNow().catch((error: unknown) => {
        logger.error({ err: error }, 'el barrido de documentos pendientes fallo');
      });
    });
    logger.info({ cron: options.scanCron }, 'barrido de documentos pendientes programado');
  }

  function exportNow(): Promise<ExportReport> {
    return exportVault({
      documents: documentsRepo,
      events: eventsRepo,
      notes: notesRepo,
      logger,
      now: () => Date.now(),
      ...(options.vaultPath === undefined ? {} : { vaultPath: options.vaultPath }),
    });
  }

  // El export no depende de los embeddings: con pgvector ausente el vault se sigue manteniendo.
  let exportTask: ScheduledTask | undefined;
  if (options.exportCron !== undefined && cronValidate(options.exportCron)) {
    exportTask = cronSchedule(options.exportCron, () => {
      void exportNow().catch((error: unknown) => {
        logger.error({ err: error }, 'el export a Obsidian fallo');
      });
    });
    logger.info({ cron: options.exportCron }, 'export a Obsidian programado');
  }

  let stopping: Promise<void> | undefined;

  function stop(): Promise<void> {
    stopping ??= (async () => {
      shuttingDown = true;
      logger.info('apagando brain');

      for (const [signal, handler] of handlers) process.off(signal, handler);
      handlers.clear();

      await scanTask?.stop();
      await exportTask?.stop();
      await worker?.close();
      await queue.close();
      connection.disconnect();

      if (options.closePool !== false) await options.pool.end();

      logger.info('brain apagado');
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
      logger.error({ reason, err: error }, 'fallo durante el apagado de brain');
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
    { model: options.embedder.model, embeddingsEnabled, concurrency: options.concurrency ?? 1 },
    'brain arrancado',
  );

  return { queue, worker, embeddingsEnabled, scanNow, exportNow, stop };
}
