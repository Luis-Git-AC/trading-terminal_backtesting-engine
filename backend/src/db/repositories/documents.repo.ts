import { createHash } from 'node:crypto';
import type { Queryable } from './candles.repo.js';

export const MAX_DOCUMENTS_LIMIT = 500;
export const INSERT_BATCH_SIZE = 200;

export interface RawDocumentInput {
  source: string;
  url: string;
  title: string;
  /** Ya saneado a texto plano: aqui no entra HTML (ver `sanitizeToText`). */
  body: string;
  publishedAt: number;
  /** `publishedAt` es en realidad `fetchedAt` porque el feed no lo traia o venia en el futuro. */
  publishedAtEstimated: boolean;
  fetchedAt: number;
  lang: string | null;
}

export interface StoredRawDocument extends RawDocumentInput {
  id: string;
  contentHash: string;
}

export interface DocumentsRangeQuery {
  from: number;
  to: number;
  sources?: readonly string[] | undefined;
  /** Corte point-in-time (ADR-006): solo lo que ya estaba descargado en ese instante. */
  asOf?: number | undefined;
  limit?: number | undefined;
}

export interface DocumentTagRow {
  asset: string;
  ruleId: string;
}

export interface ReplaceTagsInput {
  documentId: string;
  /** Reglas evaluadas en esta pasada: solo se podan las etiquetas que pusieron estas. */
  ruleIds: readonly string[];
  tags: readonly DocumentTagRow[];
}

export interface ReplaceTagsResult {
  added: number;
  removed: number;
}

export interface DocumentsRepository {
  /** Inserta los nuevos y devuelve cuantos entraron; un `content_hash` repetido se ignora. */
  insertDocuments(documents: readonly RawDocumentInput[]): Promise<number>;
  getDocuments(query: DocumentsRangeQuery): Promise<StoredRawDocument[]>;
  getDocumentsByIds(ids: readonly string[]): Promise<StoredRawDocument[]>;
  /** Reetiquetado por regla: lo que pusieron otras reglas no se toca. */
  replaceTags(input: ReplaceTagsInput): Promise<ReplaceTagsResult>;
  getTags(documentId: string): Promise<DocumentTagRow[]>;
  /** Las etiquetas de varios documentos de una vez: la busqueda devuelve hasta 50 por consulta. */
  getTagsForDocuments(ids: readonly string[]): Promise<Map<string, DocumentTagRow[]>>;
}

/**
 * Hash del cuerpo normalizado, no de la URL: el mismo articulo llega con parametros de tracking
 * distintos y seria un duplicado. Normalizar = minusculas y espacios colapsados, para que un
 * reformateo del feed no cree un documento nuevo.
 */
export function documentContentHash(body: string): string {
  return createHash('sha256')
    .update(body.replace(/\s+/gu, ' ').trim().toLowerCase(), 'utf8')
    .digest('hex');
}

const INSERT_SQL = `
  INSERT INTO raw_documents
    (source, url, title, body, content_hash, published_at, published_at_estimated, fetched_at, lang)
  SELECT doc.source, doc.url, doc.title, doc.body, doc.content_hash, doc.published_at,
         doc.published_at_estimated, doc.fetched_at, doc.lang
  FROM jsonb_to_recordset($1::jsonb) AS doc(
    source text, url text, title text, body text, content_hash text, published_at timestamptz,
    published_at_estimated boolean, fetched_at timestamptz, lang text)
  ON CONFLICT (content_hash) DO NOTHING
`;

const SELECT_SQL = `
  SELECT id::text AS id, source, url, title, body, content_hash, published_at,
         published_at_estimated, fetched_at, lang
  FROM raw_documents
  WHERE published_at >= $1
    AND published_at <= $2
    AND ($3::text[] IS NULL OR source = ANY($3::text[]))
    AND ($4::timestamptz IS NULL OR fetched_at <= $4)
  ORDER BY published_at DESC, id
  LIMIT $5
`;

// Insertar antes de borrar y sin transaccion a proposito: al reves, el `DELETE` y el `INSERT` de
// una misma sentencia comparten snapshot y el indice unico aun ve la fila borrada. Asi, si el
// proceso se cae entre las dos, lo que queda es una etiqueta de sobra que la pasada siguiente poda.
const INSERT_TAGS_SQL = `
  INSERT INTO document_tags (document_id, asset, rule_id)
  SELECT $1::uuid, tag.asset, tag.rule_id
  FROM jsonb_to_recordset($2::jsonb) AS tag(asset text, rule_id text)
  ON CONFLICT (document_id, asset, rule_id) DO NOTHING
`;

const PRUNE_TAGS_SQL = `
  DELETE FROM document_tags
  WHERE document_id = $1::uuid
    AND rule_id = ANY($2::text[])
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_to_recordset($3::jsonb) AS tag(asset text, rule_id text)
      WHERE tag.asset = document_tags.asset AND tag.rule_id = document_tags.rule_id
    )
`;

const SELECT_BY_IDS_SQL = `
  SELECT id::text AS id, source, url, title, body, content_hash, published_at,
         published_at_estimated, fetched_at, lang
  FROM raw_documents
  WHERE id = ANY($1::uuid[])
  ORDER BY published_at DESC, id
`;

const SELECT_TAGS_SQL = `
  SELECT asset, rule_id FROM document_tags WHERE document_id = $1::uuid
  ORDER BY asset, rule_id
`;

const SELECT_TAGS_BY_IDS_SQL = `
  SELECT document_id::text AS document_id, asset, rule_id
  FROM document_tags
  WHERE document_id = ANY($1::uuid[])
  ORDER BY document_id, asset, rule_id
`;

interface TagRow {
  asset: string;
  rule_id: string;
}

interface Row {
  id: string;
  source: string;
  url: string;
  title: string;
  body: string;
  content_hash: string;
  published_at: Date;
  published_at_estimated: boolean;
  fetched_at: Date;
  lang: string | null;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return MAX_DOCUMENTS_LIMIT;
  return Math.min(Math.max(1, Math.trunc(limit)), MAX_DOCUMENTS_LIMIT);
}

function toStoredDocument(row: Row): StoredRawDocument {
  return {
    id: row.id,
    source: row.source,
    url: row.url,
    title: row.title,
    body: row.body,
    contentHash: row.content_hash,
    publishedAt: row.published_at.getTime(),
    publishedAtEstimated: row.published_at_estimated,
    fetchedAt: row.fetched_at.getTime(),
    lang: row.lang,
  };
}

export function createDocumentsRepository(db: Queryable): DocumentsRepository {
  return {
    async insertDocuments(documents: readonly RawDocumentInput[]): Promise<number> {
      if (documents.length === 0) return 0;

      // Dedupe dentro del propio lote: dos entradas iguales en la misma pasada chocarian en el
      // mismo `INSERT` y Postgres no resuelve `ON CONFLICT` contra la fila que aun no existe.
      const unique = new Map<string, RawDocumentInput>();
      for (const document of documents) {
        const hash = documentContentHash(document.body);
        if (!unique.has(hash)) unique.set(hash, document);
      }

      const rows = [...unique].map(([contentHash, document]) => ({
        source: document.source,
        url: document.url,
        title: document.title,
        body: document.body,
        content_hash: contentHash,
        published_at: new Date(document.publishedAt).toISOString(),
        published_at_estimated: document.publishedAtEstimated,
        fetched_at: new Date(document.fetchedAt).toISOString(),
        lang: document.lang,
      }));

      let affected = 0;
      for (let start = 0; start < rows.length; start += INSERT_BATCH_SIZE) {
        const result = await db.query(INSERT_SQL, [
          JSON.stringify(rows.slice(start, start + INSERT_BATCH_SIZE)),
        ]);
        affected += result.rowCount ?? 0;
      }
      return affected;
    },

    async getDocuments(query: DocumentsRangeQuery): Promise<StoredRawDocument[]> {
      const { rows } = await db.query<Row>(SELECT_SQL, [
        new Date(query.from),
        new Date(query.to),
        query.sources === undefined || query.sources.length === 0 ? null : [...query.sources],
        query.asOf === undefined ? null : new Date(query.asOf),
        clampLimit(query.limit),
      ]);

      return rows.map(toStoredDocument);
    },

    async getDocumentsByIds(ids: readonly string[]): Promise<StoredRawDocument[]> {
      if (ids.length === 0) return [];
      const { rows } = await db.query<Row>(SELECT_BY_IDS_SQL, [[...ids]]);
      return rows.map(toStoredDocument);
    },

    async replaceTags(input: ReplaceTagsInput): Promise<ReplaceTagsResult> {
      const tags = JSON.stringify(
        input.tags.map((tag) => ({ asset: tag.asset, rule_id: tag.ruleId })),
      );

      const inserted = await db.query(INSERT_TAGS_SQL, [input.documentId, tags]);
      const pruned =
        input.ruleIds.length === 0
          ? { rowCount: 0 }
          : await db.query(PRUNE_TAGS_SQL, [input.documentId, [...input.ruleIds], tags]);

      return { added: inserted.rowCount ?? 0, removed: pruned.rowCount ?? 0 };
    },

    async getTags(documentId: string): Promise<DocumentTagRow[]> {
      const { rows } = await db.query<TagRow>(SELECT_TAGS_SQL, [documentId]);
      return rows.map((row) => ({ asset: row.asset, ruleId: row.rule_id }));
    },

    async getTagsForDocuments(ids: readonly string[]): Promise<Map<string, DocumentTagRow[]>> {
      const byDocument = new Map<string, DocumentTagRow[]>();
      if (ids.length === 0) return byDocument;

      const { rows } = await db.query<TagRow & { document_id: string }>(SELECT_TAGS_BY_IDS_SQL, [
        [...ids],
      ]);
      for (const row of rows) {
        const tag = { asset: row.asset, ruleId: row.rule_id };
        const group = byDocument.get(row.document_id);
        if (group === undefined) byDocument.set(row.document_id, [tag]);
        else group.push(tag);
      }
      return byDocument;
    },
  };
}
