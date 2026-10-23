import type { Queryable } from './candles.repo.js';

export const MAX_SEARCH_CANDIDATES = 200;

export interface SearchFilters {
  /** Rango sobre `published_at`, cerrado por los dos lados como el resto de la fase 9. */
  from: number;
  to: number;
  /** Etiquetas de `document_tags`; un documento vale si tiene alguna. */
  assets?: readonly string[] | undefined;
  sources?: readonly string[] | undefined;
  /** Corte point-in-time (ADR-006): solo lo que ya estaba descargado en ese instante. */
  asOf?: number | undefined;
  limit: number;
}

export interface FullTextQuery extends SearchFilters {
  /** Texto tal cual lo escribio el usuario; se interpreta con `websearch_to_tsquery`. */
  text: string;
}

export interface VectorQuery extends SearchFilters {
  embedding: readonly number[];
  model: string;
}

export interface RankedDocument {
  documentId: string;
  /** Posicion en este ranking, empezando en 1. */
  rank: number;
}

export interface SearchRepository {
  searchFullText(query: FullTextQuery): Promise<RankedDocument[]>;
  searchVector(query: VectorQuery): Promise<RankedDocument[]>;
}

/**
 * Los filtros son los mismos en los dos rankings, asi que viven en un solo sitio: si uno filtrara
 * distinto que el otro, la fusion mezclaria dos corpus diferentes.
 *
 * `$2..$6` son from, to, assets, sources y asOf; `$1` lo usa cada ranking para lo suyo.
 */
const FILTERS_SQL = `
    AND doc.published_at >= $2
    AND doc.published_at <= $3
    AND ($4::text[] IS NULL OR EXISTS (
      SELECT 1 FROM document_tags tag
      WHERE tag.document_id = doc.id AND tag.asset = ANY($4::text[])
    ))
    AND ($5::text[] IS NULL OR doc.source = ANY($5::text[]))
    AND ($6::timestamptz IS NULL OR doc.fetched_at <= $6)
`;

// `ts_rank_cd` mira la proximidad entre terminos, no solo la frecuencia. El desempate por fecha e
// id hace el orden total: sin el, dos documentos con el mismo rank saldrian en orden arbitrario.
const FULLTEXT_SQL = `
  SELECT doc.id::text AS id
  FROM raw_documents doc
  WHERE doc.search_tsv @@ websearch_to_tsquery(tt_tsconfig(doc.lang), $1)
  ${FILTERS_SQL}
  ORDER BY ts_rank_cd(doc.search_tsv, websearch_to_tsquery(tt_tsconfig(doc.lang), $1)) DESC,
           doc.published_at DESC, doc.id
  LIMIT $7
`;

// shortcut: agrupar por documento deja fuera el indice HNSW (el planificador no puede usarlo con
// un agregado), asi que esto es un escaneo de `document_embeddings`. Con un corpus personal
// (decenas de miles de trozos) sobra. Upgrade: si el corpus crece, sacar los candidatos con ANN
// sobre un conjunto ya filtrado y agrupar despues.
const VECTOR_SQL = `
  SELECT doc.id::text AS id, min(emb.embedding <=> $1::vector) AS distance
  FROM document_embeddings emb
  JOIN raw_documents doc ON doc.id = emb.document_id
  WHERE emb.model = $7
  ${FILTERS_SQL}
  GROUP BY doc.id, doc.published_at
  ORDER BY distance, doc.published_at DESC, doc.id
  LIMIT $8
`;

function listOrNull(values: readonly string[] | undefined): string[] | null {
  return values === undefined || values.length === 0 ? null : [...values];
}

function filterValues(filters: SearchFilters): unknown[] {
  return [
    new Date(filters.from),
    new Date(filters.to),
    listOrNull(filters.assets),
    listOrNull(filters.sources),
    filters.asOf === undefined ? null : new Date(filters.asOf),
  ];
}

function clampLimit(limit: number): number {
  return Math.min(Math.max(1, Math.trunc(limit)), MAX_SEARCH_CANDIDATES);
}

function ranked(rows: readonly { id: string }[]): RankedDocument[] {
  return rows.map((row, index) => ({ documentId: row.id, rank: index + 1 }));
}

/** `pgvector` acepta el literal `[1,2,3]`; enviarlo como texto evita depender de su driver. */
function toVectorLiteral(values: readonly number[]): string {
  return `[${values.join(',')}]`;
}

export function createSearchRepository(db: Queryable): SearchRepository {
  return {
    async searchFullText(query: FullTextQuery): Promise<RankedDocument[]> {
      const { rows } = await db.query<{ id: string }>(FULLTEXT_SQL, [
        query.text,
        ...filterValues(query),
        clampLimit(query.limit),
      ]);
      return ranked(rows);
    },

    async searchVector(query: VectorQuery): Promise<RankedDocument[]> {
      if (query.embedding.length === 0) return [];

      const { rows } = await db.query<{ id: string }>(VECTOR_SQL, [
        toVectorLiteral(query.embedding),
        ...filterValues(query),
        query.model,
        clampLimit(query.limit),
      ]);
      return ranked(rows);
    },
  };
}
