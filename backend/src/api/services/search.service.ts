import {
  DOCUMENTS_MAX_LIMIT,
  type DocumentResponse,
  type DocumentsSearchResponse,
  type SearchMode,
} from '@tt/shared';
import { EmbedderUnavailableError, type Embedder } from '../../brain/embeddings/embedder.js';
import type { DocumentsRepository } from '../../db/repositories/documents.repo.js';
import type { EmbeddingsRepository } from '../../db/repositories/embeddings.repo.js';
import type { RankedDocument, SearchRepository } from '../../db/repositories/search.repo.js';
import type { AppLogger } from '../../observability/logger.js';
import { AppError } from '../errors.js';

/**
 * Constante de la Reciprocal Rank Fusion. 60 es el valor del articulo original (Cormack et al.):
 * amortigua las primeras posiciones lo justo para que un segundo puesto en los dos rankings gane
 * a un primero en uno solo. No hay pesos que calibrar, que es la razon de elegir RRF.
 */
export const RRF_K = 60;

/** Se piden mas candidatos a cada ranking que resultados finales: la fusion necesita solape. */
export const CANDIDATE_FACTOR = 4;

export const SNIPPET_CHARS = 280;

export interface SearchServiceDeps {
  readonly documents: DocumentsRepository;
  readonly embeddings: EmbeddingsRepository;
  readonly search: SearchRepository;
  readonly logger: AppLogger;
  readonly now: () => number;
  /** Sin embedder no hay busqueda vectorial: el servicio degrada a full-text y lo dice. */
  readonly embedder?: Embedder | undefined;
}

export interface DocumentsSearchRequest {
  readonly q: string;
  readonly from?: number | undefined;
  readonly to?: number | undefined;
  readonly asOf?: number | undefined;
  readonly asset?: readonly string[] | undefined;
  readonly source?: readonly string[] | undefined;
  readonly limit?: number | undefined;
}

interface Fused {
  readonly documentId: string;
  readonly score: number;
  readonly fullTextRank: number | null;
  readonly vectorRank: number | null;
}

/**
 * Fusiona los dos rankings sumando `1 / (k + posicion)`. Determinista: el desempate va por la
 * mejor posicion y, si tambien empata, por el id, asi que el mismo corpus da el mismo orden.
 */
export function fuseRankings(
  fullText: readonly RankedDocument[],
  vector: readonly RankedDocument[],
): Fused[] {
  const byId = new Map<string, { fullTextRank: number | null; vectorRank: number | null }>();

  for (const item of fullText) {
    byId.set(item.documentId, { fullTextRank: item.rank, vectorRank: null });
  }
  for (const item of vector) {
    const existing = byId.get(item.documentId);
    if (existing === undefined)
      byId.set(item.documentId, { fullTextRank: null, vectorRank: item.rank });
    else byId.set(item.documentId, { ...existing, vectorRank: item.rank });
  }

  const contribution = (rank: number | null): number => (rank === null ? 0 : 1 / (RRF_K + rank));

  return [...byId]
    .map(([documentId, ranks]) => ({
      documentId,
      score: contribution(ranks.fullTextRank) + contribution(ranks.vectorRank),
      ...ranks,
    }))
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      const bestA = Math.min(a.fullTextRank ?? Infinity, a.vectorRank ?? Infinity);
      const bestB = Math.min(b.fullTextRank ?? Infinity, b.vectorRank ?? Infinity);
      if (bestA !== bestB) return bestA - bestB;
      return a.documentId < b.documentId ? -1 : 1;
    });
}

function scopeOf(
  request: DocumentsSearchRequest,
  now: () => number,
): { from: number; to: number; limit: number } {
  const limit = request.limit ?? DOCUMENTS_MAX_LIMIT;
  if (limit > DOCUMENTS_MAX_LIMIT) {
    throw AppError.rangeTooLarge(`limit maximo ${DOCUMENTS_MAX_LIMIT}, se pidieron ${limit}`);
  }

  const from = request.from ?? 0;
  const to = request.to ?? now();
  if (to <= from) {
    throw AppError.validation('El rango esta vacio', [
      { path: 'query.to', message: 'to debe ser mayor que from' },
    ]);
  }

  return { from, to, limit };
}

export async function searchDocuments(
  deps: SearchServiceDeps,
  request: DocumentsSearchRequest,
): Promise<DocumentsSearchResponse> {
  const scope = scopeOf(request, deps.now);
  const filters = {
    from: scope.from,
    to: scope.to,
    limit: scope.limit * CANDIDATE_FACTOR,
    ...(request.asset === undefined ? {} : { assets: request.asset }),
    ...(request.source === undefined ? {} : { sources: request.source }),
    ...(request.asOf === undefined ? {} : { asOf: request.asOf }),
  };

  const fullText = await deps.search.searchFullText({ ...filters, text: request.q });

  let mode: SearchMode = 'hybrid';
  let degradedReason: string | null = null;
  let vector: RankedDocument[] = [];

  const embedder = deps.embedder;
  if (embedder === undefined) {
    mode = 'fulltext';
    degradedReason = 'el API no tiene modelo de embeddings cargado';
  } else if (!(await deps.embeddings.isAvailable())) {
    // Mismo patron que ADR-002: sin la extension se sirve lo que se puede, diciendolo.
    mode = 'fulltext';
    degradedReason = 'pgvector no esta disponible en esta base de datos';
  } else {
    try {
      const [embedding] = await embedder.embed([request.q]);
      vector =
        embedding === undefined
          ? []
          : await deps.search.searchVector({ ...filters, embedding, model: embedder.model });
    } catch (error) {
      // Un modelo que no carga no debe dejar la busqueda sin resultados: full-text ya los tiene.
      mode = 'fulltext';
      degradedReason =
        error instanceof EmbedderUnavailableError
          ? 'el modelo de embeddings no esta disponible'
          : 'la busqueda vectorial fallo';
      deps.logger.warn({ err: error, q: request.q }, 'busqueda degradada a full-text');
    }
  }

  const fused = fuseRankings(fullText, vector).slice(0, scope.limit);
  const documents = await deps.documents.getDocumentsByIds(fused.map((item) => item.documentId));
  const byId = new Map(documents.map((document) => [document.id, document]));
  const tags = await deps.documents.getTagsForDocuments(fused.map((item) => item.documentId));

  const results = fused.flatMap((item) => {
    const document = byId.get(item.documentId);
    if (document === undefined) return [];

    return [
      {
        id: document.id,
        source: document.source,
        url: document.url,
        title: document.title,
        publishedAt: document.publishedAt,
        publishedAtEstimated: document.publishedAtEstimated,
        fetchedAt: document.fetchedAt,
        lang: document.lang,
        assets: [...new Set((tags.get(item.documentId) ?? []).map((tag) => tag.asset))].sort(),
        snippet: document.body.slice(0, SNIPPET_CHARS),
        score: item.score,
        fullTextRank: item.fullTextRank,
        vectorRank: item.vectorRank,
      },
    ];
  });

  return {
    query: request.q,
    mode,
    degradedReason,
    count: results.length,
    results,
    asOf: request.asOf ?? null,
  };
}

export async function getDocument(deps: SearchServiceDeps, id: string): Promise<DocumentResponse> {
  const [document] = await deps.documents.getDocumentsByIds([id]);
  if (document === undefined) {
    throw AppError.notFound(`No hay documento con id ${id}`);
  }

  const tags = await deps.documents.getTags(id);

  return {
    id: document.id,
    source: document.source,
    url: document.url,
    title: document.title,
    body: document.body,
    contentHash: document.contentHash,
    publishedAt: document.publishedAt,
    publishedAtEstimated: document.publishedAtEstimated,
    fetchedAt: document.fetchedAt,
    lang: document.lang,
    assets: [...new Set(tags.map((tag) => tag.asset))].sort(),
    tags,
  };
}
