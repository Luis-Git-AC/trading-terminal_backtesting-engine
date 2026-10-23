import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../db/migrate.js';
import {
  createDocumentsRepository,
  type DocumentsRepository,
} from '../../db/repositories/documents.repo.js';
import { createScratchDatabase, type ScratchDatabase } from '../../testing/scratch-db.js';
import { RULES, type TagRule } from './rules.js';
import { tagDocument } from './tag.js';

const DOC = {
  source: 'coindesk',
  url: 'https://example.test/gold-and-fomc',
  title: 'Gold holds after the FOMC',
  body: 'Spot gold rose as bullion demand picked up; XAU/USD held after the Federal Reserve meeting.',
  publishedAt: Date.UTC(2026, 9, 21, 9, 30, 0),
  publishedAtEstimated: false,
  fetchedAt: Date.UTC(2026, 9, 23, 7, 0, 0),
  lang: 'en',
};

const RULE_IDS = RULES.map((rule) => rule.id);

describe('reetiquetado contra la base de datos', () => {
  let db: ScratchDatabase;
  let repo: DocumentsRepository;
  let documentId: string;

  beforeAll(async () => {
    db = await createScratchDatabase({ applicationName: 'tt-itest-tagging' });
    await runMigrations({ pool: db.pool });
    repo = createDocumentsRepository(db.pool);
  });

  afterAll(async () => {
    await db.drop();
  });

  beforeEach(async () => {
    await db.pool.query('TRUNCATE raw_documents CASCADE');
    await repo.insertDocuments([DOC]);
    const [stored] = await repo.getDocuments({ from: 0, to: Date.UTC(2027, 0, 1) });
    documentId = stored!.id;
  });

  async function etiquetar(rules: readonly TagRule[] = RULES) {
    return await repo.replaceTags({
      documentId,
      ruleIds: rules.map((rule) => rule.id),
      tags: tagDocument(DOC, rules),
    });
  }

  it('guarda las etiquetas con la regla que las puso', async () => {
    expect(await etiquetar()).toEqual({ added: 3, removed: 0 });
    expect(await repo.getTags(documentId)).toEqual([
      { asset: 'gold', ruleId: 'gold-nombres-v1' },
      { asset: 'gold', ruleId: 'gold-tickers-v1' },
      { asset: 'macro', ruleId: 'macro-nombres-v1' },
    ]);
  });

  it('reetiquetar dos veces no cambia nada', async () => {
    await etiquetar();
    const antes = await repo.getTags(documentId);

    expect(await etiquetar()).toEqual({ added: 0, removed: 0 });
    expect(await repo.getTags(documentId)).toEqual(antes);
  });

  it('cambiar una regla solo altera las etiquetas de ese rule_id', async () => {
    await etiquetar();

    // `gold-tickers` pasa a v2 y deja de reconocer `XAU`; las demas reglas no se tocan.
    const v2: readonly TagRule[] = [
      ...RULES.filter((rule) => rule.id !== 'gold-tickers-v1'),
      { id: 'gold-tickers-v2', asset: 'gold', terms: ['xauusd'] },
    ];
    expect(await repo.replaceTags({ documentId, ruleIds: ['gold-tickers-v1'], tags: [] })).toEqual({
      added: 0,
      removed: 1,
    });
    expect(await etiquetar(v2)).toEqual({ added: 0, removed: 0 });

    expect(await repo.getTags(documentId)).toEqual([
      { asset: 'gold', ruleId: 'gold-nombres-v1' },
      { asset: 'macro', ruleId: 'macro-nombres-v1' },
    ]);
  });

  it('una pasada con un subconjunto de reglas no poda las etiquetas de las demas', async () => {
    await etiquetar();

    const soloMacro = RULES.filter((rule) => rule.id === 'macro-nombres-v1');
    expect(await etiquetar(soloMacro)).toEqual({ added: 0, removed: 0 });
    expect(await repo.getTags(documentId)).toHaveLength(3);
  });

  it('borrar el documento se lleva sus etiquetas', async () => {
    await etiquetar();
    await db.pool.query('DELETE FROM raw_documents WHERE id = $1', [documentId]);
    expect(await repo.getTags(documentId)).toEqual([]);
  });

  it('la clave compuesta impide la misma etiqueta dos veces', async () => {
    const insert = `INSERT INTO document_tags (document_id, asset, rule_id)
                    VALUES ($1, 'gold', 'gold-nombres-v1')`;
    await db.pool.query(insert, [documentId]);
    await expect(db.pool.query(insert, [documentId])).rejects.toThrow(/document_tags_pkey/);
  });

  it('las etiquetas no pueden colgar de un documento inexistente', async () => {
    await expect(
      db.pool.query(
        `INSERT INTO document_tags (document_id, asset, rule_id)
         VALUES ('00000000-0000-0000-0000-000000000000', 'gold', 'gold-nombres-v1')`,
      ),
    ).rejects.toThrow(/document_id|foreign key/);
  });

  it('el reetiquetado con las reglas al completo no toca nada si ya estaba al dia', async () => {
    await etiquetar();
    const { rows } = await db.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM document_tags',
    );
    expect(rows[0]?.count).toBe('3');
    expect(RULE_IDS).toContain('macro-nombres-v1');
  });
});
