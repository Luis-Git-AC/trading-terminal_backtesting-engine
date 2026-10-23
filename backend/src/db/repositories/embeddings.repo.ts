import type { Queryable } from './candles.repo.js';

export const DEFAULT_PENDING_LIMIT = 50;

export interface EmbeddingChunk {
  chunkIdx: number;
  chunkText: string;
  embedding: readonly number[];
}

export interface ReplaceEmbeddingsInput {
  documentId: string;
  model: string;
  chunks: readonly EmbeddingChunk[];
}

export interface PendingQuery {
  model: string;
  limit?: number | undefined;
}

export interface StoredEmbedding {
  chunkIdx: number;
  chunkText: string;
  embedding: number[];
  model: string;
}

export interface EmbeddingsRepository {
  /** `true` si la extension `vector` esta instalada y la tabla existe (migracion 009). */
  isAvailable(): Promise<boolean>;
  /** Documentos sin embeddings para ese modelo, lo mas reciente primero. */
  pendingDocuments(query: PendingQuery): Promise<string[]>;
  /** Todos los trozos del documento en una sola sentencia: o entran todos, o ninguno. */
  replaceEmbeddings(input: ReplaceEmbeddingsInput): Promise<number>;
  getEmbeddings(documentId: string, model: string): Promise<StoredEmbedding[]>;
}

const AVAILABLE_SQL = `
  SELECT to_regclass('public.document_embeddings') IS NOT NULL AS ok
`;

const PENDING_SQL = `
  SELECT doc.id::text AS id
  FROM raw_documents doc
  WHERE NOT EXISTS (
    SELECT 1 FROM document_embeddings emb
    WHERE emb.document_id = doc.id AND emb.model = $1
  )
  ORDER BY doc.published_at DESC, doc.id
  LIMIT $2
`;

// Una sola sentencia para todos los trozos: un documento a medias embebido seria peor que uno sin
// embeber, porque la busqueda lo daria por hecho. `DO UPDATE` para que reembeber sea idempotente.
const REPLACE_SQL = `
  INSERT INTO document_embeddings (document_id, chunk_idx, chunk_text, embedding, model)
  SELECT $1::uuid, chunk.chunk_idx, chunk.chunk_text, chunk.embedding::vector, $2
  FROM jsonb_to_recordset($3::jsonb)
    AS chunk(chunk_idx integer, chunk_text text, embedding text)
  ON CONFLICT (document_id, chunk_idx, model)
  DO UPDATE SET chunk_text = excluded.chunk_text, embedding = excluded.embedding
`;

const SELECT_SQL = `
  SELECT chunk_idx, chunk_text, embedding::text AS embedding, model
  FROM document_embeddings
  WHERE document_id = $1::uuid AND model = $2
  ORDER BY chunk_idx
`;

interface Row {
  chunk_idx: number;
  chunk_text: string;
  embedding: string;
  model: string;
}

/** `pgvector` acepta el literal `[1,2,3]`; enviarlo como texto evita depender de su driver. */
function toVectorLiteral(values: readonly number[]): string {
  return `[${values.join(',')}]`;
}

export function createEmbeddingsRepository(db: Queryable): EmbeddingsRepository {
  return {
    async isAvailable(): Promise<boolean> {
      const { rows } = await db.query<{ ok: boolean }>(AVAILABLE_SQL);
      return rows[0]?.ok === true;
    },

    async pendingDocuments(query: PendingQuery): Promise<string[]> {
      const limit = Math.max(1, Math.trunc(query.limit ?? DEFAULT_PENDING_LIMIT));
      const { rows } = await db.query<{ id: string }>(PENDING_SQL, [query.model, limit]);
      return rows.map((row) => row.id);
    },

    async replaceEmbeddings(input: ReplaceEmbeddingsInput): Promise<number> {
      if (input.chunks.length === 0) return 0;

      const payload = JSON.stringify(
        input.chunks.map((chunk) => ({
          chunk_idx: chunk.chunkIdx,
          chunk_text: chunk.chunkText,
          embedding: toVectorLiteral(chunk.embedding),
        })),
      );

      const { rowCount } = await db.query(REPLACE_SQL, [input.documentId, input.model, payload]);
      return rowCount ?? 0;
    },

    async getEmbeddings(documentId: string, model: string): Promise<StoredEmbedding[]> {
      const { rows } = await db.query<Row>(SELECT_SQL, [documentId, model]);
      return rows.map((row) => ({
        chunkIdx: row.chunk_idx,
        chunkText: row.chunk_text,
        embedding: (JSON.parse(row.embedding) as number[]).map(Number),
        model: row.model,
      }));
    },
  };
}
