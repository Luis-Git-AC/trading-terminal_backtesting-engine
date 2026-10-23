import type { Pool } from 'pg';
import {
  createDocumentsRepository,
  type DocumentsRepository,
  type RawDocumentInput,
} from '../../db/repositories/documents.repo.js';
import type {
  NormalizedBatch,
  PersistResult,
  SourceAdapter,
  SourceContext,
  SourceItem,
} from '../adapter.js';
import { DEFAULT_FEEDS, type FeedConfig } from './feeds.js';
import { FeedParseError, parseFeed } from './parse.js';

export const RSS_SOURCE_ID = 'rss';

/** Un feed real pesa decenas de kB; esto es solo el tope para dato no confiable. */
export const MAX_FEED_CHARS = 32 * 1024 * 1024;
/** Un articulo largo son ~40 kB de texto. Lo que pase de aqui no es un articulo. */
export const MAX_BODY_CHARS = 256 * 1024;

export interface RssResponse {
  readonly status: number;
  text(): Promise<string>;
}

export type RssFetch = (url: string) => Promise<RssResponse>;

export type RssDiscard =
  | { kind: 'feed'; feedId: string; reason: string }
  | { kind: 'document'; feedId: string; url: string; reason: string };

/** La fuente solo escribe: el etiquetado y la lectura son de otros. */
export type RssDocumentsRepository = Pick<DocumentsRepository, 'insertDocuments'>;

export interface RssSourceOptions {
  pool: Pool;
  fetch: RssFetch;
  schedule: string;
  feeds?: readonly FeedConfig[] | undefined;
  documentsRepo?: RssDocumentsRepository | undefined;
  onDiscard?: ((discard: RssDiscard) => void) | undefined;
}

interface FeedFetch {
  readonly feed: FeedConfig;
  readonly xml: string | null;
  readonly error: string | null;
}

export interface RssRaw {
  readonly fetchedAt: number;
  readonly feeds: readonly FeedFetch[];
}

/** Interseccion y no `extends`: `SourceItem` declara sus dos marcas `readonly` y el input no. */
type DocumentItem = RawDocumentInput & SourceItem;

function noop(): void {
  // Sin `onDiscard` los descartes solo se cuentan en el informe de la pasada.
}

export function createRssSource(options: RssSourceOptions): SourceAdapter<RssRaw, DocumentItem> {
  const repo = options.documentsRepo ?? createDocumentsRepository(options.pool);
  const feeds = options.feeds ?? DEFAULT_FEEDS;
  const discard = options.onDiscard ?? noop;

  return {
    id: RSS_SOURCE_ID,
    schedule: options.schedule,
    requiredEnv: [],

    async fetch(_since: Date | null, context: SourceContext): Promise<RssRaw> {
      const fetchedAt = context.now();
      const results: FeedFetch[] = [];

      for (const feed of feeds) {
        await context.limiter.acquire();
        try {
          const response = await options.fetch(feed.url);
          if (response.status !== 200) {
            results.push({ feed, xml: null, error: `respondio ${String(response.status)}` });
            continue;
          }
          const xml = await response.text();
          if (xml.length > MAX_FEED_CHARS) {
            results.push({
              feed,
              xml: null,
              error: `pasa de ${String(MAX_FEED_CHARS)} caracteres`,
            });
            continue;
          }
          results.push({ feed, xml, error: null });
        } catch (error) {
          // Un feed caido no tumba la pasada: se registra y se sigue con los demas.
          results.push({
            feed,
            xml: null,
            error: error instanceof Error ? error.message : 'error',
          });
        }
      }

      return { fetchedAt, feeds: results };
    },

    normalize(raw: RssRaw): NormalizedBatch<DocumentItem> {
      const items: DocumentItem[] = [];
      let discarded = 0;

      const drop = (feedId: string, url: string, reason: string): void => {
        discarded += 1;
        discard({ kind: 'document', feedId, url, reason });
      };

      for (const result of raw.feeds) {
        if (result.xml === null) {
          discarded += 1;
          discard({ kind: 'feed', feedId: result.feed.id, reason: result.error ?? 'sin cuerpo' });
          continue;
        }

        let entries;
        try {
          entries = parseFeed(result.xml, result.feed.lang);
        } catch (error) {
          // XML roto: igual que un feed caido, se registra y los demas siguen su camino.
          discarded += 1;
          discard({
            kind: 'feed',
            feedId: result.feed.id,
            reason: error instanceof FeedParseError ? error.message : 'XML ilegible',
          });
          continue;
        }

        for (const entry of entries) {
          if (entry.url.length === 0) {
            drop(result.feed.id, '', 'entrada sin enlace');
            continue;
          }
          if (entry.body.length === 0) {
            // Sin cuerpo no hay hash de contenido con el que deduplicar.
            drop(result.feed.id, entry.url, 'cuerpo vacio');
            continue;
          }
          if (entry.body.length > MAX_BODY_CHARS) {
            drop(
              result.feed.id,
              entry.url,
              `cuerpo de ${String(entry.body.length)} caracteres, tope ${String(MAX_BODY_CHARS)}`,
            );
            continue;
          }

          // Sin fecha, o con una fecha en el futuro, manda `fetchedAt` y queda marcado.
          const usable = entry.publishedAt !== null && entry.publishedAt <= raw.fetchedAt;
          items.push({
            source: result.feed.id,
            url: entry.url,
            title: entry.title,
            body: entry.body,
            publishedAt: usable && entry.publishedAt !== null ? entry.publishedAt : raw.fetchedAt,
            publishedAtEstimated: !usable,
            fetchedAt: raw.fetchedAt,
            lang: entry.lang,
          });
        }
      }

      return { sourceId: RSS_SOURCE_ID, items, discarded };
    },

    async persist(batch: NormalizedBatch<DocumentItem>): Promise<PersistResult> {
      // Raw inmutable: lo ya guardado no se reescribe, el repetido se ignora.
      const written = await repo.insertDocuments(batch.items);
      return { written, skipped: batch.items.length - written };
    },
  };
}
