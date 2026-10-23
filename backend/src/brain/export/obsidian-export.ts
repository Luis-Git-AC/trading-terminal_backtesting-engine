import type { DocumentsRepository } from '../../db/repositories/documents.repo.js';
import type { EventsRepository } from '../../db/repositories/events.repo.js';
import type { NotesRepository } from '../../db/repositories/notes.repo.js';
import type { AppLogger } from '../../observability/logger.js';
import {
  nodeVaultFs,
  safeFileName,
  writeVaultFiles,
  type ExportReport,
  type VaultFile,
  type VaultFs,
} from './obsidian.js';

/** Tope por pasada: el export es una vista, no un volcado del historico entero. */
export const DEFAULT_EXPORT_LIMIT = 200;

export interface VaultExportDeps {
  readonly documents: DocumentsRepository;
  readonly events: EventsRepository;
  readonly notes: NotesRepository;
  readonly logger: AppLogger;
  readonly now: () => number;
  /** Sin ruta no hay export: el resto de `brain` funciona igual. */
  readonly vaultPath?: string | undefined;
  readonly limit?: number | undefined;
  readonly fs?: VaultFs | undefined;
}

const EMPTY: ExportReport = { written: [], unchanged: [], conflicts: [] };

/** Los valores del frontmatter pueden traer `:` o `#`: entrecomillados no rompen el YAML. */
function quoted(value: string): string {
  return JSON.stringify(value);
}

function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

function dayOf(ms: number): string {
  return isoOf(ms).slice(0, 10);
}

function yamlList(values: readonly string[]): string {
  return `[${values.map(quoted).join(', ')}]`;
}

function documentFile(
  document: {
    id: string;
    source: string;
    url: string;
    title: string;
    body: string;
    publishedAt: number;
    publishedAtEstimated: boolean;
    fetchedAt: number;
    lang: string | null;
  },
  assets: readonly string[],
  slug: string,
): VaultFile {
  return {
    path: `documents/${slug}.md`,
    frontmatter: {
      document_id: document.id,
      source: quoted(document.source),
      url: quoted(document.url),
      published: quoted(isoOf(document.publishedAt)),
      published_estimated: String(document.publishedAtEstimated),
      fetched: quoted(isoOf(document.fetchedAt)),
      lang: document.lang === null ? 'null' : quoted(document.lang),
      assets: yamlList(assets),
    },
    body: [
      `# ${document.title}`,
      '',
      `[Original](${document.url}) · fuente: ${document.source} · publicado: ${isoOf(document.publishedAt)}`,
      '',
      document.body,
      '',
      assets.length === 0 ? '' : `Activos: ${assets.map((asset) => `[[${asset}]]`).join(', ')}`,
      '',
    ].join('\n'),
  };
}

function eventFile(event: {
  id: string;
  source: string;
  type: string;
  assetTags: readonly string[];
  scheduledAt: number;
  publishedAt: number;
  payload: Record<string, unknown>;
}): VaultFile {
  const slug = safeFileName(`${dayOf(event.scheduledAt)}-${event.type}`, event.id.slice(0, 8));

  return {
    path: `events/${slug}-${event.id.slice(0, 8)}.md`,
    frontmatter: {
      event_id: event.id,
      source: quoted(event.source),
      type: quoted(event.type),
      scheduled: quoted(isoOf(event.scheduledAt)),
      published: quoted(isoOf(event.publishedAt)),
      assets: yamlList([...event.assetTags]),
    },
    body: [
      `# ${event.type} · ${dayOf(event.scheduledAt)}`,
      '',
      `Fuente: ${event.source} · previsto: ${isoOf(event.scheduledAt)}`,
      '',
      '```json',
      JSON.stringify(event.payload, null, 2),
      '```',
      '',
      event.assetTags.length === 0
        ? ''
        : `Activos: ${event.assetTags.map((asset) => `[[${asset}]]`).join(', ')}`,
      '',
    ].join('\n'),
  };
}

function noteFile(
  note: {
    id: string;
    author: string;
    assetTags: readonly string[];
    bodyMd: string;
    sourceDocumentIds: readonly string[];
    createdAt: number;
  },
  slugsById: ReadonlyMap<string, string>,
): VaultFile {
  const links = note.sourceDocumentIds
    .map((id) => slugsById.get(id))
    .filter((slug): slug is string => slug !== undefined)
    .map((slug) => `[[documents/${slug}]]`);

  return {
    path: `notes/${dayOf(note.createdAt)}-${note.id.slice(0, 8)}.md`,
    frontmatter: {
      note_id: note.id,
      // Las notas de Claude nunca son input de un backtest: el autor queda a la vista.
      author: quoted(note.author),
      created: quoted(isoOf(note.createdAt)),
      assets: yamlList([...note.assetTags]),
    },
    body: [
      `# Nota de ${note.author} · ${dayOf(note.createdAt)}`,
      '',
      note.bodyMd,
      '',
      links.length === 0 ? '' : `Fuentes: ${links.join(', ')}`,
      '',
      note.assetTags.length === 0
        ? ''
        : `Activos: ${note.assetTags.map((asset) => `[[${asset}]]`).join(', ')}`,
      '',
    ].join('\n'),
  };
}

/** Una nota indice por activo: es el nodo del que cuelgan los wikilinks en el grafo de Obsidian. */
function assetFile(
  asset: string,
  documents: readonly { title: string; slug: string; publishedAt: number }[],
): VaultFile {
  const ordered = [...documents].sort((a, b) => b.publishedAt - a.publishedAt);

  return {
    path: `${asset}.md`,
    frontmatter: { asset: quoted(asset), documents: String(ordered.length) },
    body: [
      `# ${asset}`,
      '',
      `${String(ordered.length)} documentos etiquetados.`,
      '',
      ...ordered.map(
        (document) =>
          `- ${dayOf(document.publishedAt)} · [[documents/${document.slug}|${document.title}]]`,
      ),
      '',
    ].join('\n'),
  };
}

/**
 * Reconstruye la vista del vault desde la base de datos (ADR-006: Obsidian es una vista). Solo
 * escribe lo que ha cambiado y nunca toca un fichero que no haya generado el, asi que ejecutarlo
 * dos veces seguidas deja el vault igual.
 */
export async function exportVault(deps: VaultExportDeps): Promise<ExportReport> {
  const root = deps.vaultPath;
  if (root === undefined || root.length === 0) {
    deps.logger.warn(
      'OBSIDIAN_VAULT_PATH no esta definida: el export a Obsidian queda desactivado',
    );
    return EMPTY;
  }

  const limit = deps.limit ?? DEFAULT_EXPORT_LIMIT;
  const documents = await deps.documents.getDocuments({ from: 0, to: deps.now(), limit });
  const tags = await deps.documents.getTagsForDocuments(documents.map((document) => document.id));

  // Un titulo repetido en dos medios daria el mismo slug: el id corto lo desempata sin depender
  // del orden en que lleguen los documentos.
  const slugsById = new Map(
    documents.map((document) => [
      document.id,
      `${safeFileName(document.title, 'documento')}-${document.id.slice(0, 8)}`,
    ]),
  );

  const byAsset = new Map<string, { title: string; slug: string; publishedAt: number }[]>();
  const files: VaultFile[] = [];

  for (const document of documents) {
    const assets = [...new Set((tags.get(document.id) ?? []).map((tag) => tag.asset))].sort();
    // Documento relevante = etiquetado. Sin etiqueta no entra en ningun indice y seria ruido.
    if (assets.length === 0) continue;

    const slug = slugsById.get(document.id) ?? document.id;
    files.push(documentFile(document, assets, slug));

    for (const asset of assets) {
      const group = byAsset.get(asset);
      const entry = { title: document.title, slug, publishedAt: document.publishedAt };
      if (group === undefined) byAsset.set(asset, [entry]);
      else group.push(entry);
    }
  }

  for (const [asset, entries] of [...byAsset].sort(([a], [b]) => (a < b ? -1 : 1))) {
    files.push(assetFile(asset, entries));
  }

  for (const event of await deps.events.getEvents({ from: 0, to: deps.now(), limit })) {
    files.push(eventFile(event));
  }

  for (const note of await deps.notes.getNotes({ limit })) {
    files.push(noteFile(note, slugsById));
  }

  const report = await writeVaultFiles(deps.fs ?? nodeVaultFs, root, files);

  if (report.conflicts.length > 0) {
    // El conflicto se registra y no se pisa: una nota que el usuario edito es suya.
    deps.logger.warn(
      { conflictos: report.conflicts },
      'export a Obsidian: ficheros no sobrescritos porque no los generamos nosotros o se editaron a mano',
    );
  }
  deps.logger.info(
    {
      escritos: report.written.length,
      sinCambios: report.unchanged.length,
      conflictos: report.conflicts.length,
    },
    'export a Obsidian terminado',
  );

  return report;
}
