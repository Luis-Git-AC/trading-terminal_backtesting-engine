import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../db/migrate.js';
import {
  createDocumentsRepository,
  type DocumentsRepository,
} from '../../db/repositories/documents.repo.js';
import { createEventsRepository } from '../../db/repositories/events.repo.js';
import { createNotesRepository, type NotesRepository } from '../../db/repositories/notes.repo.js';
import { createLogger } from '../../observability/logger.js';
import { createScratchDatabase, type ScratchDatabase } from '../../testing/scratch-db.js';
import { VAULT_FOLDER } from './obsidian.js';
import { exportVault } from './obsidian-export.js';

const NOW = Date.UTC(2026, 9, 25);
const FETCHED = Date.UTC(2026, 9, 24);

/** Un titulo malicioso entre los normales: el export convierte titulos en rutas. */
const CORPUS = [
  {
    source: 'oilprice',
    url: 'https://example.test/crude',
    title: 'Crude inventories build again',
    body: 'Brent slipped after the weekly petroleum report showed another crude inventory build.',
    publishedAt: Date.UTC(2026, 9, 23, 9, 0, 0),
    publishedAtEstimated: false,
    fetchedAt: FETCHED,
    lang: 'en',
  },
  {
    source: 'fed-press',
    url: 'https://example.test/fomc',
    title: '../../etc/passwd: FOMC holds rates',
    body: 'The Federal Reserve left the target range unchanged as inflation cooled.',
    publishedAt: Date.UTC(2026, 9, 24, 9, 0, 0),
    publishedAtEstimated: false,
    fetchedAt: FETCHED,
    lang: 'en',
  },
  {
    source: 'coindesk',
    url: 'https://example.test/sin-etiquetas',
    title: 'Something nobody tagged',
    body: 'A document with no tags at all, so it is not relevant for the vault.',
    publishedAt: Date.UTC(2026, 9, 22, 9, 0, 0),
    publishedAtEstimated: false,
    fetchedAt: FETCHED,
    lang: 'en',
  },
] as const;

describe('export del vault de Obsidian', () => {
  let db: ScratchDatabase;
  let documents: DocumentsRepository;
  let notes: NotesRepository;
  let vault: string;

  beforeAll(async () => {
    db = await createScratchDatabase({ applicationName: 'tt-itest-obsidian' });
    await runMigrations({ pool: db.pool });
    documents = createDocumentsRepository(db.pool);
    notes = createNotesRepository(db.pool);
  });

  afterAll(async () => {
    await db.drop();
  });

  beforeEach(async () => {
    vault = await mkdtemp(join(tmpdir(), 'tt-vault-'));
    await db.pool.query('TRUNCATE raw_documents CASCADE');
    await db.pool.query('TRUNCATE market_events');
    await db.pool.query('TRUNCATE notes');

    await documents.insertDocuments([...CORPUS]);
    const stored = await documents.getDocuments({ from: 0, to: NOW });

    for (const document of stored) {
      const asset =
        document.source === 'oilprice' ? 'oil' : document.source === 'fed-press' ? 'macro' : null;
      if (asset === null) continue;
      await documents.replaceTags({
        documentId: document.id,
        ruleIds: [`${asset}-nombres-v1`],
        tags: [{ asset, ruleId: `${asset}-nombres-v1` }],
      });
    }

    await createEventsRepository(db.pool).upsertEvents([
      {
        source: 'eia',
        type: 'eia-wpsr',
        assetTags: ['oil'],
        scheduledAt: Date.UTC(2026, 9, 21, 14, 30, 0),
        publishedAt: Date.UTC(2026, 9, 21, 14, 30, 0),
        fetchedAt: FETCHED,
        payload: { report: 'weekly-petroleum-status' },
      },
    ]);

    const crudo = stored.find((document) => document.source === 'oilprice');
    await notes.createNote({
      author: 'claude',
      assetTags: ['oil'],
      bodyMd: 'Los inventarios llevan tres semanas subiendo.',
      sourceDocumentIds: crudo === undefined ? [] : [crudo.id],
    });
  });

  afterEach(async () => {
    await rm(vault, { recursive: true, force: true });
  });

  /** `sinRuta` y no un parametro opcional: pasar `undefined` activaria el valor por defecto. */
  function run(options: { readonly sinRuta?: boolean } = {}) {
    return exportVault({
      documents,
      events: createEventsRepository(db.pool),
      notes,
      logger: createLogger({ role: 'brain', level: 'silent' }),
      now: () => NOW,
      ...(options.sinRuta === true ? {} : { vaultPath: vault }),
    });
  }

  async function listar(folder: string): Promise<string[]> {
    return (await readdir(join(vault, VAULT_FOLDER, folder))).sort();
  }

  it('escribe documentos etiquetados, indices por activo, eventos y notas', async () => {
    const report = await run();

    expect(report.conflicts).toEqual([]);
    expect(report.written).toHaveLength(6);

    const docs = await listar('documents');
    expect(docs).toHaveLength(2);
    // El documento sin etiquetas no entra: no es relevante.
    expect(docs.join(' ')).not.toContain('something-nobody-tagged');

    expect(await listar('.')).toContain('oil.md');
    expect(await listar('.')).toContain('macro.md');
    expect(await listar('events')).toHaveLength(1);
    expect(await listar('notes')).toHaveLength(1);
  });

  it('el titulo con ../../ produce un nombre seguro dentro de la carpeta del vault', async () => {
    await run();

    const docs = await listar('documents');
    const peligroso = docs.find((name) => name.includes('passwd'));
    expect(peligroso).toMatch(/^etc-passwd-fomc-holds-rates-[0-9a-f]{8}\.md$/u);
    // Nada fuera de la carpeta generada.
    expect((await readdir(vault)).sort()).toEqual([VAULT_FOLDER]);
  });

  it('la nota del indice de un activo enlaza con wikilinks a sus documentos', async () => {
    await run();

    const indice = await readFile(join(vault, VAULT_FOLDER, 'oil.md'), 'utf8');
    expect(indice).toContain('[[documents/crude-inventories-build-again-');
    expect(indice).toContain('1 documentos etiquetados');
  });

  it('la nota de Claude se marca con su autor y enlaza con su documento fuente', async () => {
    await run();

    const [nombre] = await listar('notes');
    const nota = await readFile(join(vault, VAULT_FOLDER, 'notes', nombre!), 'utf8');
    expect(nota).toContain('author: "claude"');
    expect(nota).toContain('[[documents/crude-inventories-build-again-');
  });

  it('dos pasadas dejan el vault igual y la segunda no reescribe nada', async () => {
    const primera = await run();
    const antes = await Promise.all(
      primera.written.map((relative) => readFile(join(vault, VAULT_FOLDER, relative), 'utf8')),
    );

    const segunda = await run();
    expect(segunda.written).toEqual([]);
    expect(segunda.unchanged).toEqual(primera.written);

    const despues = await Promise.all(
      primera.written.map((relative) => readFile(join(vault, VAULT_FOLDER, relative), 'utf8')),
    );
    expect(despues).toEqual(antes);
  });

  it('un fichero generado y editado a mano no se sobrescribe y queda registrado', async () => {
    const primera = await run();
    const relativo = primera.written.find((path) => path.startsWith('documents/'))!;
    const absoluto = join(vault, VAULT_FOLDER, relativo);

    const original = await readFile(absoluto, 'utf8');
    const editado = `${original}\n\nEsto lo he escrito yo a mano.\n`;
    await writeFile(absoluto, editado, 'utf8');

    const segunda = await run();
    expect(segunda.conflicts).toEqual([{ path: relativo, reason: 'editado-a-mano' }]);
    expect(await readFile(absoluto, 'utf8')).toBe(editado);
  });

  it('una nota del usuario con el mismo nombre no se toca', async () => {
    const primera = await run();
    const relativo = primera.written.find((path) => path.startsWith('documents/'))!;
    const absoluto = join(vault, VAULT_FOLDER, relativo);
    await writeFile(absoluto, '# mi nota, sin frontmatter\n', 'utf8');

    const segunda = await run();
    expect(segunda.conflicts).toEqual([{ path: relativo, reason: 'ajeno' }]);
    expect(await readFile(absoluto, 'utf8')).toBe('# mi nota, sin frontmatter\n');
  });

  it('un documento nuevo se anade sin tocar los que ya estaban', async () => {
    const primera = await run();

    await documents.insertDocuments([
      {
        source: 'mining-com',
        url: 'https://example.test/gold',
        title: 'Gold bullion demand climbs',
        body: 'Central banks kept buying gold bullion.',
        publishedAt: Date.UTC(2026, 9, 24, 12, 0, 0),
        publishedAtEstimated: false,
        fetchedAt: FETCHED,
        lang: 'en',
      },
    ]);
    const nuevo = (await documents.getDocuments({ from: 0, to: NOW })).find(
      (document) => document.source === 'mining-com',
    )!;
    await documents.replaceTags({
      documentId: nuevo.id,
      ruleIds: ['gold-nombres-v1'],
      tags: [{ asset: 'gold', ruleId: 'gold-nombres-v1' }],
    });

    const segunda = await run();
    expect(segunda.conflicts).toEqual([]);
    // El documento nuevo y su indice de activo; los demas siguen igual.
    expect(segunda.written.some((path) => path.includes('gold-bullion'))).toBe(true);
    expect(segunda.written).toContain('gold.md');
    expect(segunda.unchanged).toContain('oil.md');
    // Los 6 de la primera pasada siguen igual; lo nuevo son el documento y su indice.
    expect(segunda.written).toHaveLength(2);
    expect(segunda.unchanged).toHaveLength(primera.written.length);
  });

  it('sin OBSIDIAN_VAULT_PATH no escribe nada y no revienta', async () => {
    const report = await run({ sinRuta: true });

    expect(report).toEqual({ written: [], unchanged: [], conflicts: [] });
    expect(await readdir(vault)).toEqual([]);
  });
});
