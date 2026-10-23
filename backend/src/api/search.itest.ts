import {
  documentResponseSchema,
  documentsSearchResponseSchema,
  type DocumentsSearchResponse,
} from '@tt/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMBEDDING_DIMENSIONS,
  EmbedderUnavailableError,
  type Embedder,
} from '../brain/embeddings/embedder.js';
import { runMigrations } from '../db/migrate.js';
import {
  createDocumentsRepository,
  type DocumentsRepository,
} from '../db/repositories/documents.repo.js';
import {
  createEmbeddingsRepository,
  type EmbeddingsRepository,
} from '../db/repositories/embeddings.repo.js';
import { createSearchRepository } from '../db/repositories/search.repo.js';
import { createLogger } from '../observability/logger.js';
import { createScratchDatabase, type ScratchDatabase } from '../testing/scratch-db.js';
import { documentsRouter } from './routes/documents.js';
import { createApiApp } from './server.js';

const MODEL = 'test/fake-minilm';
const NOW = Date.UTC(2026, 9, 25);
const PRIMERA = Date.UTC(2026, 9, 22);
const SEGUNDA = Date.UTC(2026, 9, 24);

/**
 * Corpus fijo. Los cuerpos estan escritos para que full-text los distinga sin ambiguedad: cada
 * documento tiene su vocabulario y no se solapan.
 */
const CORPUS = [
  {
    source: 'coindesk',
    url: 'https://example.test/bitcoin-etf',
    title: 'Bitcoin ETF inflows hit a record',
    body: 'Spot bitcoin ETFs absorbed a record amount of capital as BTC funding turned positive.',
    publishedAt: Date.UTC(2026, 9, 20, 9, 0, 0),
    publishedAtEstimated: false,
    fetchedAt: PRIMERA,
    lang: 'en',
  },
  {
    source: 'mining-com',
    url: 'https://example.test/gold-bullion',
    title: 'Gold bullion demand climbs',
    body: 'Central banks kept buying gold bullion while XAU/USD held above its moving average.',
    publishedAt: Date.UTC(2026, 9, 21, 9, 0, 0),
    publishedAtEstimated: false,
    fetchedAt: PRIMERA,
    lang: 'en',
  },
  {
    source: 'oilprice',
    url: 'https://example.test/crude-inventories',
    title: 'Crude inventories build again',
    body: 'Brent slipped after the weekly petroleum report showed another crude inventory build.',
    publishedAt: Date.UTC(2026, 9, 23, 9, 0, 0),
    publishedAtEstimated: false,
    fetchedAt: SEGUNDA,
    lang: 'en',
  },
  {
    source: 'fed-press',
    url: 'https://example.test/fomc-statement',
    title: 'FOMC statement leaves rates unchanged',
    body: 'The Federal Reserve left the target range unchanged as inflation cooled toward target.',
    publishedAt: Date.UTC(2026, 9, 24, 9, 0, 0),
    publishedAtEstimated: false,
    fetchedAt: SEGUNDA,
    lang: 'en',
  },
] as const;

/** Sin descarga de modelo: el vector depende del texto, asi que el orden es reproducible. */
function fakeEmbedder(options: { readonly fails?: boolean } = {}): Embedder {
  return {
    model: MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    embed(texts: readonly string[]): Promise<number[][]> {
      if (options.fails === true) {
        return Promise.reject(new EmbedderUnavailableError('el modelo no esta en la cache'));
      }
      return Promise.resolve(
        texts.map((text) =>
          Array.from(
            { length: EMBEDDING_DIMENSIONS },
            (_, index) => ((text.length + index) % 97) / 97,
          ),
        ),
      );
    },
  };
}

describe('API de busqueda de documentos', () => {
  let db: ScratchDatabase;
  let documents: DocumentsRepository;
  let embeddings: EmbeddingsRepository;
  let ids: Map<string, string>;

  beforeAll(async () => {
    db = await createScratchDatabase({ applicationName: 'tt-itest-api-search' });
    await runMigrations({ pool: db.pool });
    documents = createDocumentsRepository(db.pool);
    embeddings = createEmbeddingsRepository(db.pool);
  });

  afterAll(async () => {
    await db.drop();
  });

  beforeEach(async () => {
    await db.pool.query('TRUNCATE raw_documents CASCADE');
    await documents.insertDocuments([...CORPUS]);

    const stored = await documents.getDocuments({ from: 0, to: NOW });
    ids = new Map(stored.map((document) => [document.source, document.id]));

    // Etiquetas y embeddings del corpus: lo que dejarian F10-T2 y F10-T3.
    for (const document of stored) {
      const asset =
        document.source === 'coindesk'
          ? 'btc'
          : document.source === 'mining-com'
            ? 'gold'
            : document.source === 'oilprice'
              ? 'oil'
              : 'macro';
      await documents.replaceTags({
        documentId: document.id,
        ruleIds: [`${asset}-nombres-v1`],
        tags: [{ asset, ruleId: `${asset}-nombres-v1` }],
      });

      const [vector] = await fakeEmbedder().embed([document.body]);
      await embeddings.replaceEmbeddings({
        documentId: document.id,
        model: MODEL,
        chunks: [{ chunkIdx: 0, chunkText: document.body, embedding: vector ?? [] }],
      });
    }
  });

  function makeApp(embedder: Embedder | undefined, repos?: { embeddings?: EmbeddingsRepository }) {
    const logger = createLogger({ role: 'api', level: 'silent' });
    return createApiApp({
      logger,
      webOrigin: 'https://terminal.example',
      version: '0.1.0',
      uptimeSec: () => 1,
      checkDb: () => Promise.resolve(),
      checkRedis: () => Promise.resolve(),
      registerRoutes: (router) => {
        router.use(
          documentsRouter({
            documents,
            embeddings: repos?.embeddings ?? embeddings,
            search: createSearchRepository(db.pool),
            logger,
            now: () => NOW,
            ...(embedder === undefined ? {} : { embedder }),
          }),
        );
      },
    });
  }

  async function search(
    query: string,
    options: {
      readonly embedder?: Embedder | undefined;
      readonly embeddings?: EmbeddingsRepository;
    } = {},
  ): Promise<DocumentsSearchResponse> {
    const app = makeApp(
      'embedder' in options ? options.embedder : fakeEmbedder(),
      options.embeddings === undefined ? undefined : { embeddings: options.embeddings },
    );
    const response = await request(app).get(`/api/documents/search?${query}`);
    expect(response.status).toBe(200);
    return documentsSearchResponseSchema.parse(response.body);
  }

  it('devuelve resultados ordenados y validos contra el contrato', async () => {
    const payload = await search('q=crude%20inventories');

    expect(payload.mode).toBe('hybrid');
    expect(payload.degradedReason).toBeNull();
    expect(payload.results[0]?.url).toBe('https://example.test/crude-inventories');
    expect(payload.results[0]?.assets).toEqual(['oil']);
    expect(payload.results[0]?.fullTextRank).toBe(1);
    expect(payload.results[0]?.snippet).toContain('Brent slipped');
    // Orden no creciente de puntuacion.
    const scores = payload.results.map((result) => result.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('mismo corpus y misma consulta dan el mismo orden', async () => {
    const primera = await search('q=gold%20bullion');
    for (let intento = 0; intento < 3; intento += 1) {
      const otra = await search('q=gold%20bullion');
      expect(otra.results.map((result) => result.id)).toEqual(
        primera.results.map((result) => result.id),
      );
      expect(otra.results.map((result) => result.score)).toEqual(
        primera.results.map((result) => result.score),
      );
    }
  });

  it('filtra por activo', async () => {
    const payload = await search('q=record%20or%20bullion%20or%20crude&asset=gold');
    expect(payload.results.map((result) => result.source)).toEqual(['mining-com']);
  });

  it('filtra por fuente y por rango de fechas', async () => {
    const porFuente = await search('q=crude%20or%20bullion&source=oilprice');
    expect(porFuente.results.map((result) => result.source)).toEqual(['oilprice']);

    const porFecha = await search(
      `q=crude%20or%20bullion%20or%20record&from=${String(Date.UTC(2026, 9, 23))}`,
    );
    expect(porFecha.results.every((result) => result.publishedAt >= Date.UTC(2026, 9, 23))).toBe(
      true,
    );
    expect(porFecha.results.map((result) => result.source)).not.toContain('coindesk');
  });

  it('asOf excluye los documentos descargados despues de esa fecha', async () => {
    const todos = await search('q=crude%20or%20bullion%20or%20inflation');
    expect(todos.results.length).toBeGreaterThan(1);

    const antiguos = await search(
      `q=crude%20or%20bullion%20or%20inflation&asOf=${String(PRIMERA)}`,
    );
    expect(antiguos.asOf).toBe(PRIMERA);
    expect(antiguos.results.every((result) => result.fetchedAt <= PRIMERA)).toBe(true);
    expect(antiguos.results.map((result) => result.source)).not.toContain('oilprice');
    expect(antiguos.results.map((result) => result.source)).not.toContain('fed-press');
  });

  it('respeta el limite pedido', async () => {
    const payload = await search('q=crude%20or%20bullion%20or%20record%20or%20inflation&limit=2');
    expect(payload.results).toHaveLength(2);
    expect(payload.count).toBe(2);
  });

  it('sin modelo de embeddings la busqueda sigue y la respuesta lo dice', async () => {
    const payload = await search('q=crude%20inventories', { embedder: undefined });

    expect(payload.mode).toBe('fulltext');
    expect(payload.degradedReason).toBe('el API no tiene modelo de embeddings cargado');
    expect(payload.results[0]?.url).toBe('https://example.test/crude-inventories');
    expect(payload.results[0]?.vectorRank).toBeNull();
  });

  it('sin pgvector la busqueda cae a full-text y lo indica', async () => {
    const payload = await search('q=crude%20inventories', {
      embeddings: { ...embeddings, isAvailable: () => Promise.resolve(false) },
    });

    expect(payload.mode).toBe('fulltext');
    expect(payload.degradedReason).toBe('pgvector no esta disponible en esta base de datos');
    expect(payload.results).not.toHaveLength(0);
  });

  it('si el modelo no carga, degrada en vez de dejar la busqueda sin resultados', async () => {
    const payload = await search('q=crude%20inventories', {
      embedder: fakeEmbedder({ fails: true }),
    });

    expect(payload.mode).toBe('fulltext');
    expect(payload.degradedReason).toBe('el modelo de embeddings no esta disponible');
    expect(payload.results).not.toHaveLength(0);
  });

  it('sin coincidencia lexica el ranking vectorial sigue proponiendo lo mas cercano', async () => {
    // La ANN no tiene umbral: siempre devuelve los vecinos mas proximos. Es lo que se quiere de
    // una busqueda semantica, y por eso cada resultado dice en que ranking entro.
    const hibrida = await search('q=palladium%20zirconium');
    expect(hibrida.results).not.toHaveLength(0);
    expect(hibrida.results.every((result) => result.fullTextRank === null)).toBe(true);

    // En modo degradado no hay de donde sacarlos, asi que la lista va vacia y sin error.
    const degradada = await search('q=palladium%20zirconium', { embedder: undefined });
    expect(degradada).toMatchObject({ count: 0, results: [], mode: 'fulltext' });
  });

  it('rechaza una consulta demasiado corta', async () => {
    const response = await request(makeApp(fakeEmbedder())).get('/api/documents/search?q=a');
    expect(response.status).toBe(400);
  });

  it('/api/documents/:id devuelve el documento con su cuerpo y sus etiquetas', async () => {
    const id = ids.get('fed-press')!;
    const response = await request(makeApp(fakeEmbedder())).get(`/api/documents/${id}`);

    expect(response.status).toBe(200);
    const payload = documentResponseSchema.parse(response.body);
    expect(payload).toMatchObject({
      id,
      source: 'fed-press',
      title: 'FOMC statement leaves rates unchanged',
      assets: ['macro'],
      tags: [{ asset: 'macro', ruleId: 'macro-nombres-v1' }],
    });
    expect(payload.body).toContain('Federal Reserve');
  });

  it('un id que no existe es 404 y uno que no es uuid es 400', async () => {
    const app = makeApp(fakeEmbedder());
    expect(
      (await request(app).get('/api/documents/00000000-0000-0000-0000-000000000000')).status,
    ).toBe(404);
    expect((await request(app).get('/api/documents/no-soy-un-uuid')).status).toBe(400);
  });
});
