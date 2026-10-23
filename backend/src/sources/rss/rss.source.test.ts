import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  documentContentHash,
  type RawDocumentInput,
} from '../../db/repositories/documents.repo.js';
import { createRateLimiter } from '../../ingest/rate-limiter.js';
import type { SourceContext } from '../adapter.js';
import type { FeedConfig } from './feeds.js';
import { createRssSource, MAX_BODY_CHARS, RSS_SOURCE_ID, type RssDiscard } from './rss.source.js';

const NOW = Date.UTC(2026, 9, 23, 7, 0, 0);
const CONTEXT: SourceContext = { limiter: createRateLimiter({ rps: 1000 }), now: () => NOW };
const DIEZ_MB = 10 * 1024 * 1024;

function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../__fixtures__/rss/${name}.xml`, import.meta.url)),
    'utf8',
  );
}

const CRYPTO = fixture('crypto-rss');
const ATOM = fixture('fed-atom');
const ROTO = fixture('roto');

const CRYPTO_FEED: FeedConfig = { id: 'crypto', url: 'https://crypto.test/rss', lang: 'en' };
const FED_FEED: FeedConfig = { id: 'fed', url: 'https://fed.test/atom', lang: 'en' };
const FEEDS: readonly FeedConfig[] = [CRYPTO_FEED, FED_FEED];

/** Nunca sale a la red: cada URL con su cuerpo, o con el fallo que pida el caso. */
function source(
  bodies: Readonly<Record<string, string | number | Error>>,
  feeds: readonly FeedConfig[] = FEEDS,
) {
  const written: RawDocumentInput[] = [];
  const discards: RssDiscard[] = [];
  const stored = new Set<string>();

  return {
    written,
    discards,
    adapter: createRssSource({
      pool: undefined as never,
      schedule: '*/10 * * * *',
      feeds,
      fetch: (url) => {
        const body = bodies[url];
        if (body instanceof Error) return Promise.reject(body);
        if (typeof body === 'number') {
          return Promise.resolve({ status: body, text: () => Promise.resolve('') });
        }
        return Promise.resolve({ status: 200, text: () => Promise.resolve(body ?? '') });
      },
      documentsRepo: {
        insertDocuments: (documents) => {
          let count = 0;
          for (const document of documents) {
            const hash = documentContentHash(document.body);
            if (stored.has(hash)) continue;
            stored.add(hash);
            written.push(document);
            count += 1;
          }
          return Promise.resolve(count);
        },
        getDocuments: () => Promise.resolve([]),
      },
      onDiscard: (discard) => discards.push(discard),
    }),
  };
}

async function run(subject: ReturnType<typeof source>) {
  const raw = await subject.adapter.fetch(null, CONTEXT);
  const batch = subject.adapter.normalize(raw);
  const result = await subject.adapter.persist(batch);
  return { batch, result };
}

describe('fuente RSS', () => {
  it('se identifica sin claves de entorno', () => {
    const { adapter } = source({});
    expect(adapter.id).toBe(RSS_SOURCE_ID);
    expect(adapter.requiredEnv).toEqual([]);
  });

  it('dos entradas con el mismo contenido y URLs distintas dejan un solo documento', async () => {
    const subject = source({
      'https://crypto.test/rss': CRYPTO,
      'https://fed.test/atom': ATOM,
    });
    const { result } = await run(subject);

    const oro = subject.written.filter((document) => document.body.startsWith('Spot gold'));
    expect(oro).toHaveLength(1);
    expect(oro[0]?.url).toBe('https://example.test/gold-holds?utm_source=rss&utm_medium=feed');
    // 3 entradas del RSS - 1 duplicada + 1 del Atom
    expect(result).toEqual({ written: 3, skipped: 1 });
  });

  it('un feed con XML malformado se registra y no impide procesar el resto', async () => {
    const subject = source({
      'https://crypto.test/rss': ROTO,
      'https://fed.test/atom': ATOM,
    });
    const { batch } = await run(subject);

    expect(subject.discards).toEqual([
      { kind: 'feed', feedId: 'crypto', reason: expect.stringContaining('XML invalido') },
    ]);
    expect(batch.items.map((item) => item.source)).toEqual(['fed']);
  });

  it('un feed caido o con error HTTP tampoco tumba la pasada', async () => {
    const subject = source({
      'https://crypto.test/rss': new Error('ECONNREFUSED'),
      'https://fed.test/atom': 503,
    });
    const { batch } = await run(subject);

    expect(batch.items).toEqual([]);
    expect(subject.discards).toEqual([
      { kind: 'feed', feedId: 'crypto', reason: 'ECONNREFUSED' },
      { kind: 'feed', feedId: 'fed', reason: 'respondio 503' },
    ]);
  });

  it('el HTML con <script> se guarda como texto limpio', async () => {
    const subject = source({ 'https://crypto.test/rss': CRYPTO }, [CRYPTO_FEED]);
    await run(subject);

    const guardado = subject.written.map((document) => document.body).join(' ');
    expect(guardado).toContain('Spot gold held above $4,000 an ounce.');
    expect(guardado).not.toContain('<');
    expect(guardado).not.toContain('alert');
  });

  it('un documento de 10 MB se rechaza con motivo', async () => {
    const enorme =
      '<rss version="2.0"><channel><item><link>https://enorme.test/a</link><description>' +
      'a'.repeat(DIEZ_MB) +
      '</description></item></channel></rss>';
    const subject = source({ 'https://crypto.test/rss': enorme }, [CRYPTO_FEED]);
    const { batch } = await run(subject);

    expect(batch.items).toEqual([]);
    expect(subject.discards).toEqual([
      {
        kind: 'document',
        feedId: 'crypto',
        url: 'https://enorme.test/a',
        reason: `cuerpo de ${String(DIEZ_MB)} caracteres, tope ${String(MAX_BODY_CHARS)}`,
      },
    ]);
  });

  it('una entrada sin cuerpo o sin enlace se descarta con motivo', async () => {
    const xml =
      '<rss version="2.0"><channel><item><link>https://x.test/a</link></item>' +
      '<item><description>sin enlace</description></item></channel></rss>';
    const subject = source({ 'https://crypto.test/rss': xml }, [CRYPTO_FEED]);
    const { batch } = await run(subject);

    expect(batch.items).toEqual([]);
    expect(subject.discards).toEqual([
      { kind: 'document', feedId: 'crypto', url: 'https://x.test/a', reason: 'cuerpo vacio' },
      { kind: 'document', feedId: 'crypto', url: '', reason: 'entrada sin enlace' },
    ]);
  });

  it('una fecha en el futuro se sustituye por fetchedAt y queda marcada', async () => {
    const subject = source({ 'https://crypto.test/rss': CRYPTO }, [CRYPTO_FEED]);
    const { batch } = await run(subject);

    const futuro = batch.items.find((item) => item.url === 'https://example.test/no-date');
    expect(futuro).toMatchObject({ publishedAt: NOW, publishedAtEstimated: true });

    const normal = batch.items.find((item) => item.body.startsWith('Spot gold'));
    expect(normal).toMatchObject({
      publishedAt: Date.UTC(2026, 9, 21, 9, 30, 0),
      publishedAtEstimated: false,
      fetchedAt: NOW,
      lang: 'en',
    });
  });

  it('una segunda pasada sobre el mismo feed no escribe nada: el crudo es inmutable', async () => {
    const subject = source({ 'https://crypto.test/rss': CRYPTO }, [CRYPTO_FEED]);
    const primera = await run(subject);
    const segunda = await run(subject);

    expect(primera.result.written).toBe(2);
    expect(segunda.result).toEqual({ written: 0, skipped: 3 });
    expect(subject.written).toHaveLength(2);
  });
});
