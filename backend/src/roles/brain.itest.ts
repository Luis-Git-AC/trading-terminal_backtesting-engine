import { randomUUID } from 'node:crypto';
import { BRAIN_QUEUE_NAME } from '@tt/shared';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EMBEDDING_DIMENSIONS, type Embedder } from '../brain/embeddings/embedder.js';
import { runMigrations } from '../db/migrate.js';
import { createDocumentsRepository } from '../db/repositories/documents.repo.js';
import { createEmbeddingsRepository } from '../db/repositories/embeddings.repo.js';
import { createLogger } from '../observability/logger.js';
import { createQueueConnection } from '../queue/connection.js';
import { createScratchDatabase, type ScratchDatabase } from '../testing/scratch-db.js';
import { startBrain, type BrainHandle } from './brain.js';

const MODEL = 'test/fake-minilm';
const FETCHED_AT = Date.UTC(2026, 9, 23, 7, 0, 0);

function requireRedisUrl(): string {
  const url = process.env.REDIS_URL;
  if (url === undefined || url === '') {
    throw new Error(
      'REDIS_URL no esta definida. Copia .env.example a .env y ejecuta npm run db:up.',
    );
  }
  return url;
}

/** Sin descarga de modelo: un vector sintetico derivado del texto, deterministico. */
function fakeEmbedder(
  options: {
    readonly delayMs?: number;
    readonly dimensions?: number;
    readonly fails?: boolean;
  } = {},
): Embedder & { calls: number } {
  const embedder = {
    calls: 0,
    model: MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    async embed(texts: readonly string[]): Promise<number[][]> {
      embedder.calls += 1;
      if (options.delayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }
      if (options.fails === true) throw new Error('el modelo revento');

      return texts.map((text) =>
        Array.from(
          { length: options.dimensions ?? EMBEDDING_DIMENSIONS },
          (_, index) => ((text.length + index) % 97) / 97,
        ),
      );
    },
  };
  return embedder;
}

function documento(url: string, body: string) {
  return {
    source: 'coindesk',
    url,
    title: 'Gold holds after the FOMC',
    body,
    publishedAt: Date.UTC(2026, 9, 21, 9, 30, 0),
    publishedAtEstimated: false,
    fetchedAt: FETCHED_AT,
    lang: 'en',
  };
}

const CUERPO = 'Spot gold rose as bullion demand picked up. '.repeat(60).trim();

describe('rol brain', () => {
  const redisUrl = requireRedisUrl();
  let db: ScratchDatabase;
  let redis: Redis;
  let handle: BrainHandle | undefined;
  let prefix: string;

  beforeAll(async () => {
    db = await createScratchDatabase({ applicationName: 'tt-itest-brain' });
    await runMigrations({ pool: db.pool });
    redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  });

  afterAll(async () => {
    const leftovers = await redis.keys('tt-itest-brain-*');
    if (leftovers.length > 0) await redis.del(...leftovers);
    await redis.quit();
    await db.drop();
  });

  beforeEach(async () => {
    handle = undefined;
    prefix = `tt-itest-brain-${randomUUID().slice(0, 8)}`;
    await db.pool.query('TRUNCATE raw_documents CASCADE');
  });

  afterEach(async () => {
    await handle?.stop();
  });

  async function launch(
    embedder: Embedder,
    options: { readonly embeddingsRepo?: Parameters<typeof startBrain>[0]['embeddingsRepo'] } = {},
  ): Promise<BrainHandle> {
    const created = await startBrain({
      pool: db.pool,
      connection: createQueueConnection(redisUrl),
      logger: createLogger({ role: 'brain', level: 'silent' }),
      embedder,
      scanCron: '*/5 * * * *',
      prefix,
      closePool: false,
      signals: [],
      ...(options.embeddingsRepo === undefined ? {} : { embeddingsRepo: options.embeddingsRepo }),
    });
    handle = created;
    return created;
  }

  async function insertar(url: string, body = CUERPO): Promise<string> {
    const repo = createDocumentsRepository(db.pool);
    await repo.insertDocuments([documento(url, body)]);
    const [stored] = await repo.getDocuments({ from: 0, to: Date.UTC(2027, 0, 1) });
    return stored!.id;
  }

  /** Espera a que la cola se vacie: el worker trabaja en su propio ciclo. */
  async function esperarCola(created: BrainHandle, intentos = 100): Promise<void> {
    for (let intento = 0; intento < intentos; intento += 1) {
      const counts = await created.queue.getJobCounts('waiting', 'active', 'delayed');
      if ((counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0) === 0)
        return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('la cola de brain no se vacio');
  }

  it('un documento nuevo acaba con sus embeddings en la base de datos sin intervencion', async () => {
    const documentId = await insertar('https://example.test/uno');
    const created = await launch(fakeEmbedder());

    expect(created.embeddingsEnabled).toBe(true);
    expect(await created.scanNow()).toBe(1);
    await esperarCola(created);

    const stored = await createEmbeddingsRepository(db.pool).getEmbeddings(documentId, MODEL);
    expect(stored.length).toBeGreaterThan(1);
    expect(stored.map((row) => row.chunkIdx)).toEqual(stored.map((_, index) => index));
    expect(stored[0]?.embedding).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(stored[0]?.chunkText).toMatch(/^Gold holds after the FOMC/u);
  });

  it('el barrido no vuelve a encolar lo que ya tiene embeddings', async () => {
    await insertar('https://example.test/uno');
    const created = await launch(fakeEmbedder());

    expect(await created.scanNow()).toBe(1);
    await esperarCola(created);
    expect(await created.scanNow()).toBe(0);
  });

  it('reembeber el mismo documento es idempotente', async () => {
    const documentId = await insertar('https://example.test/uno');
    const created = await launch(fakeEmbedder());
    const repo = createEmbeddingsRepository(db.pool);

    await created.scanNow();
    await esperarCola(created);
    const primera = await repo.getEmbeddings(documentId, MODEL);

    await created.queue.add('brain', { documentId }, { jobId: `reembed-${documentId}` });
    await esperarCola(created);

    expect(await repo.getEmbeddings(documentId, MODEL)).toEqual(primera);
  });

  it('apagar a mitad del documento deja el job reencolado y la base de datos sin trozos a medias', async () => {
    const documentId = await insertar('https://example.test/uno');
    const created = await launch(fakeEmbedder({ delayMs: 400 }));

    await created.scanNow();
    // El job esta dentro del embedder cuando llega el apagado.
    await new Promise((resolve) => setTimeout(resolve, 150));
    await created.stop();
    handle = undefined;

    expect(await createEmbeddingsRepository(db.pool).getEmbeddings(documentId, MODEL)).toEqual([]);

    // Cola nueva sobre otra conexion: la del handle ya esta cerrada despues de `stop()`.
    const cola = new Queue(BRAIN_QUEUE_NAME, {
      connection: createQueueConnection(redisUrl),
      prefix,
    });
    try {
      const counts = await cola.getJobCounts('completed', 'waiting', 'delayed', 'failed', 'active');
      expect(counts.completed).toBe(0);
      // El job sigue vivo en la cola: reencolado o a la espera de su reintento, no perdido.
      expect(
        (counts.waiting ?? 0) +
          (counts.delayed ?? 0) +
          (counts.active ?? 0) +
          (counts.failed ?? 0),
      ).toBeGreaterThan(0);
    } finally {
      await cola.close();
    }
  });

  it('si falta pgvector, arranca degradado: no monta worker y el barrido no encola nada', async () => {
    await insertar('https://example.test/uno');
    const created = await launch(fakeEmbedder(), {
      embeddingsRepo: {
        isAvailable: () => Promise.resolve(false),
        pendingDocuments: () => Promise.reject(new Error('no deberia consultarse')),
        replaceEmbeddings: () => Promise.reject(new Error('no deberia escribirse')),
        getEmbeddings: () => Promise.resolve([]),
      },
    });

    expect(created.embeddingsEnabled).toBe(false);
    expect(created.worker).toBeNull();
    expect(await created.scanNow()).toBe(0);
  });

  it('un vector con dimensiones distintas a las de la columna falla antes de escribir', async () => {
    const documentId = await insertar('https://example.test/uno', 'cuerpo corto');
    const created = await launch(fakeEmbedder({ dimensions: 10 }));

    await created.scanNow();
    // No se espera a que la cola se vacie: el job falla y BullMQ lo reintenta con backoff de 10 s.
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(await createEmbeddingsRepository(db.pool).getEmbeddings(documentId, MODEL)).toEqual([]);
  });

  it('apagar dos veces no revienta', async () => {
    const created = await launch(fakeEmbedder());
    await created.stop();
    await expect(created.stop()).resolves.toBeUndefined();
    handle = undefined;
  });

  describe('etiquetado', () => {
    async function insertarTitulado(title: string, body: string): Promise<string> {
      const repo = createDocumentsRepository(db.pool);
      await repo.insertDocuments([{ ...documento(`https://example.test/${title}`, body), title }]);
      const [stored] = await repo.getDocuments({ from: 0, to: Date.UTC(2027, 0, 1) });
      return stored!.id;
    }

    it('un documento nuevo acaba etiquetado sin intervencion', async () => {
      const documentId = await insertarTitulado('Gold rallies', 'Spot gold rose after the FOMC.');
      const created = await launch(fakeEmbedder());

      expect(await created.tagNow()).toEqual({
        evaluados: 1,
        etiquetasAnadidas: 2,
        etiquetasRetiradas: 0,
      });

      const tags = await createDocumentsRepository(db.pool).getTags(documentId);
      expect(tags.map((tag) => tag.asset).sort()).toEqual(['gold', 'macro']);
      expect(tags.some((tag) => tag.asset === 'silver')).toBe(false);
    });

    it('un documento que ninguna regla toca no deja filas y no vuelve a entrar', async () => {
      const documentId = await insertarTitulado('Tulip prices', 'Dutch tulip bulbs got cheaper.');
      const created = await launch(fakeEmbedder());

      expect((await created.tagNow()).evaluados).toBe(1);
      expect(await createDocumentsRepository(db.pool).getTags(documentId)).toEqual([]);

      // La clave del ticket: sin marca, el barrido lo reintentaria en cada pasada para siempre.
      expect(await created.tagNow()).toEqual({
        evaluados: 0,
        etiquetasAnadidas: 0,
        etiquetasRetiradas: 0,
      });
    });

    it('la segunda pasada no toca lo ya etiquetado', async () => {
      await insertarTitulado('Gold rallies', 'Spot gold rose after the FOMC.');
      const created = await launch(fakeEmbedder());

      await created.tagNow();
      expect(await created.tagNow()).toEqual({
        evaluados: 0,
        etiquetasAnadidas: 0,
        etiquetasRetiradas: 0,
      });
    });

    it('cambiar una regla reetiqueta el corpus: la huella de las reglas cambia', async () => {
      const documentId = await insertarTitulado('Gold rallies', 'Spot gold rose after the FOMC.');
      const created = await launch(fakeEmbedder());
      await created.tagNow();

      // Lo que hace un cambio de reglas en produccion: subir la version de una regla cambia la
      // huella, y la marca guardada deja de coincidir.
      await db.pool.query('UPDATE raw_documents SET tagged_rules_hash = $1', ['huella-vieja']);

      expect((await created.tagNow()).evaluados).toBe(1);
      expect(
        (await createDocumentsRepository(db.pool).getTags(documentId)).map((tag) => tag.asset).sort(),
      ).toEqual(['gold', 'macro']);
    });

    it('etiqueta con el modelo de embeddings caido', async () => {
      const documentId = await insertarTitulado('Gold rallies', 'Spot gold rose after the FOMC.');
      const created = await launch(fakeEmbedder(), {
        embeddingsRepo: {
          isAvailable: () => Promise.resolve(false),
          pendingDocuments: () => Promise.reject(new Error('no deberia consultarse')),
          replaceEmbeddings: () => Promise.reject(new Error('no deberia escribirse')),
          getEmbeddings: () => Promise.resolve([]),
        },
      });

      expect(created.embeddingsEnabled).toBe(false);
      expect((await created.tagNow()).evaluados).toBe(1);
      expect(await createDocumentsRepository(db.pool).getTags(documentId)).toHaveLength(2);
      expect(documentId).toBeTruthy();
    });
  });
});
