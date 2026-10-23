import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../db/migrate.js';
import { createDocumentsRepository } from '../../db/repositories/documents.repo.js';
import { createRateLimiter } from '../../ingest/rate-limiter.js';
import { createScratchDatabase, type ScratchDatabase } from '../../testing/scratch-db.js';
import { toRunnable } from '../adapter.js';
import type { FeedConfig } from './feeds.js';
import { createRssSource } from './rss.source.js';

const PRIMERA = Date.UTC(2026, 9, 23, 7, 0, 0);
const SEGUNDA = Date.UTC(2026, 9, 23, 7, 10, 0);

function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../__fixtures__/rss/${name}.xml`, import.meta.url)),
    'utf8',
  );
}

const CRYPTO = fixture('crypto-rss');
const ROTO = fixture('roto');

const FEEDS: readonly FeedConfig[] = [
  { id: 'crypto', url: 'https://crypto.test/rss', lang: 'en' },
  { id: 'roto', url: 'https://roto.test/rss', lang: 'en' },
];

describe('fuente RSS contra la base de datos', () => {
  let db: ScratchDatabase;

  beforeAll(async () => {
    db = await createScratchDatabase({ applicationName: 'tt-itest-rss' });
    await runMigrations({ pool: db.pool });
  });

  afterAll(async () => {
    await db.drop();
  });

  beforeEach(async () => {
    await db.pool.query('TRUNCATE raw_documents');
  });

  /** Sin red: el fixture se sirve segun la URL que pida la fuente. */
  function runnable(now: number) {
    return toRunnable(
      createRssSource({
        pool: db.pool,
        schedule: '*/10 * * * *',
        feeds: FEEDS,
        fetch: (url) =>
          Promise.resolve({
            status: 200,
            text: () => Promise.resolve(url.includes('roto') ? ROTO : CRYPTO),
          }),
      }),
    ).run(null, { limiter: createRateLimiter({ rps: 1000 }), now: () => now });
  }

  it('escribe los documentos del feed sano y deja fuera el duplicado y el feed roto', async () => {
    const report = await runnable(PRIMERA);
    expect(report).toMatchObject({ sourceId: 'rss', items: 3, discarded: 1, written: 2 });

    const stored = await createDocumentsRepository(db.pool).getDocuments({
      from: Date.UTC(2026, 0, 1),
      to: Date.UTC(2027, 0, 1),
    });
    expect(stored).toHaveLength(2);
    expect(stored.map((document) => document.source)).toEqual(['crypto', 'crypto']);
    expect(stored[0]).toMatchObject({
      publishedAt: PRIMERA,
      publishedAtEstimated: true,
      lang: 'en',
    });
    expect(stored[1]).toMatchObject({
      url: 'https://example.test/gold-holds?utm_source=rss&utm_medium=feed',
      publishedAt: Date.UTC(2026, 9, 21, 9, 30, 0),
      publishedAtEstimated: false,
    });
    expect(stored[1]?.body).not.toContain('script');
  });

  it('la segunda pasada no reescribe el crudo', async () => {
    await runnable(PRIMERA);
    const segunda = await runnable(SEGUNDA);
    expect(segunda).toMatchObject({ written: 0, skipped: 3 });

    const { rows } = await db.pool.query<{ count: string; fetched: Date }>(
      'SELECT count(*)::text AS count, max(fetched_at) AS fetched FROM raw_documents',
    );
    expect(rows[0]?.count).toBe('2');
    expect(rows[0]?.fetched.getTime()).toBe(PRIMERA);
  });

  it('el filtro asOf no devuelve lo que aun no estaba descargado', async () => {
    await runnable(SEGUNDA);
    const repo = createDocumentsRepository(db.pool);
    const rango = { from: Date.UTC(2026, 0, 1), to: Date.UTC(2027, 0, 1) };

    expect(await repo.getDocuments({ ...rango, asOf: PRIMERA })).toEqual([]);
    expect(await repo.getDocuments({ ...rango, asOf: SEGUNDA })).toHaveLength(2);
  });
});
