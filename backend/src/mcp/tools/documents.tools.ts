import {
  DOCUMENTS_MAX_LIMIT,
  MCP_BODY_CHARS,
  MCP_MAX_RESULTS,
  MCP_SNIPPET_CHARS,
  getDocumentInputSchema,
  searchDocumentsInputSchema,
  writeNoteInputSchema,
} from '@tt/shared';
import { getDocument, searchDocuments } from '../../api/services/search.service.js';
import type { McpToolDeps } from './deps.js';

export interface SearchDocumentsResult {
  readonly query: string;
  readonly mode: string;
  readonly degradedReason: string | null;
  readonly count: number;
  readonly offset: number;
  /** `true` cuando hay mas resultados: se piden con `offset`. */
  readonly hasMore: boolean;
  readonly limit: number;
  readonly results: readonly {
    id: string;
    source: string;
    title: string;
    url: string;
    publishedAt: string;
    assets: readonly string[];
    snippet: string;
    truncated: boolean;
    score: number;
  }[];
}

/**
 * Busqueda hibrida de F10-T4 con los topes del MCP: pocos resultados y cuerpos recortados, porque
 * la respuesta va a la ventana de contexto de Claude. El documento entero se pide con
 * `get_document`.
 */
export async function searchDocumentsTool(
  deps: McpToolDeps,
  input: unknown,
): Promise<SearchDocumentsResult> {
  const query = searchDocumentsInputSchema.parse(input);
  const limit = query.limit ?? MCP_MAX_RESULTS;
  const offset = query.offset ?? 0;

  // Se pide una pagina mas para saber si hay siguiente sin tener que contar el corpus entero.
  const response = await searchDocuments(deps, {
    q: query.q,
    // El servicio de busqueda tiene su propio tope duro y rechaza pedir mas.
    limit: Math.min(offset + limit + 1, DOCUMENTS_MAX_LIMIT),
    ...(query.from === undefined ? {} : { from: query.from }),
    ...(query.to === undefined ? {} : { to: query.to }),
    ...(query.asOf === undefined ? {} : { asOf: query.asOf }),
    ...(query.asset === undefined ? {} : { asset: query.asset }),
    ...(query.source === undefined ? {} : { source: query.source }),
  });

  const page = response.results.slice(offset, offset + limit);

  return {
    query: response.query,
    mode: response.mode,
    degradedReason: response.degradedReason,
    count: page.length,
    offset,
    limit,
    hasMore: response.results.length > offset + limit,
    results: page.map((result) => ({
      id: result.id,
      source: result.source,
      title: result.title,
      url: result.url,
      publishedAt: new Date(result.publishedAt).toISOString(),
      assets: result.assets,
      snippet: result.snippet.slice(0, MCP_SNIPPET_CHARS),
      truncated: result.snippet.length > MCP_SNIPPET_CHARS,
      score: result.score,
    })),
  };
}

export interface GetDocumentResult {
  readonly id: string;
  readonly source: string;
  readonly url: string;
  readonly title: string;
  readonly publishedAt: string;
  readonly publishedAtEstimated: boolean;
  readonly fetchedAt: string;
  readonly lang: string | null;
  readonly assets: readonly string[];
  readonly tags: readonly { asset: string; ruleId: string }[];
  readonly body: string;
  readonly truncated: boolean;
  readonly bodyChars: number;
}

export async function getDocumentTool(
  deps: McpToolDeps,
  input: unknown,
): Promise<GetDocumentResult> {
  const { id } = getDocumentInputSchema.parse(input);
  const document = await getDocument(deps, id);

  return {
    id: document.id,
    source: document.source,
    url: document.url,
    title: document.title,
    publishedAt: new Date(document.publishedAt).toISOString(),
    publishedAtEstimated: document.publishedAtEstimated,
    fetchedAt: new Date(document.fetchedAt).toISOString(),
    lang: document.lang,
    assets: document.assets,
    tags: document.tags,
    body: document.body.slice(0, MCP_BODY_CHARS),
    truncated: document.body.length > MCP_BODY_CHARS,
    bodyChars: document.body.length,
  };
}

export interface WriteNoteResult {
  readonly id: string;
  readonly author: 'claude';
  readonly createdAt: string;
  readonly assets: readonly string[];
  readonly sourceDocumentIds: readonly string[];
  /** Lo que el export dejo en el vault en esta misma operacion. */
  readonly vault: { written: readonly string[]; conflicts: number };
}

/**
 * La unica tool que escribe, y solo en `notes`. Las notas de Claude se guardan con
 * `author = 'claude'` y nunca son input de un backtest.
 */
export async function writeNoteTool(deps: McpToolDeps, input: unknown): Promise<WriteNoteResult> {
  const note = writeNoteInputSchema.parse(input);

  const stored = await deps.notes.createNote({
    author: 'claude',
    assetTags: note.assets ?? [],
    bodyMd: note.bodyMd,
    sourceDocumentIds: note.sourceDocumentIds ?? [],
  });

  // Persistir y exportar en la misma operacion: si la nota no aparece en el vault, para el usuario
  // es como si no se hubiera escrito.
  const report = await deps.exportVault();

  return {
    id: stored.id,
    author: 'claude',
    createdAt: new Date(stored.createdAt).toISOString(),
    assets: stored.assetTags,
    sourceDocumentIds: stored.sourceDocumentIds,
    vault: { written: report.written, conflicts: report.conflicts.length },
  };
}
