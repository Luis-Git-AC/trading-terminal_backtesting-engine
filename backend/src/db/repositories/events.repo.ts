import { createHash } from 'node:crypto';
import type { Queryable } from './candles.repo.js';

export const MAX_EVENTS_LIMIT = 1000;
export const UPSERT_BATCH_SIZE = 500;

export interface MarketEventInput {
  source: string;
  type: string;
  assetTags: readonly string[];
  /** Cuando ocurre o se publica el dato. Un FOMC se conoce con meses de antelacion. */
  scheduledAt: number;
  /** Cuando la fuente publico el registro. */
  publishedAt: number;
  fetchedAt: number;
  payload: Record<string, unknown>;
}

export interface StoredMarketEvent extends MarketEventInput {
  id: string;
  contentHash: string;
}

export interface EventsRangeQuery {
  from: number;
  to: number;
  /** Solo eventos con alguna de estas etiquetas. Sin ellas, todos. */
  tags?: readonly string[] | undefined;
  types?: readonly string[] | undefined;
  /** Corte point-in-time (ADR-006): solo lo que ya estaba descargado en ese instante. */
  asOf?: number | undefined;
  limit?: number | undefined;
}

export interface EventsRepository {
  upsertEvents(events: readonly MarketEventInput[]): Promise<number>;
  getEvents(query: EventsRangeQuery): Promise<StoredMarketEvent[]>;
}

/**
 * Claves ordenadas a proposito: el mismo evento releido tiene que dar el mismo hash, y el orden de
 * claves de un JSON no esta garantizado ni en la respuesta de la fuente ni al volver de `jsonb`.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`);
  return `{${entries.join(',')}}`;
}

/** `fetchedAt` queda fuera a proposito: releer el mismo evento manana no lo convierte en otro. */
export function eventContentHash(event: MarketEventInput): string {
  return createHash('sha256')
    .update(
      canonical({
        source: event.source,
        type: event.type,
        scheduledAt: event.scheduledAt,
        publishedAt: event.publishedAt,
        payload: event.payload,
      }),
      'utf8',
    )
    .digest('hex');
}

// Un solo jsonb en vez de arrays paralelos: `unnest` sobre un text[][] aplanaria `asset_tags`,
// porque Postgres no tiene arrays de arrays. `jsonb_to_recordset` si castea cada campo a su tipo.
const UPSERT_SQL = `
  INSERT INTO market_events
    (source, type, asset_tags, scheduled_at, published_at, fetched_at, payload, content_hash)
  SELECT event.source, event.type, event.asset_tags, event.scheduled_at, event.published_at,
         event.fetched_at, event.payload, event.content_hash
  FROM jsonb_to_recordset($1::jsonb) AS event(
    source text, type text, asset_tags text[], scheduled_at timestamptz,
    published_at timestamptz, fetched_at timestamptz, payload jsonb, content_hash text)
  ON CONFLICT (content_hash) DO NOTHING
`;

const SELECT_SQL = `
  SELECT id::text AS id, source, type, asset_tags, scheduled_at, published_at, fetched_at,
         payload, content_hash
  FROM market_events
  WHERE scheduled_at >= $1
    AND scheduled_at <= $2
    AND ($3::text[] IS NULL OR asset_tags && $3::text[])
    AND ($4::timestamptz IS NULL OR fetched_at <= $4)
    AND ($6::text[] IS NULL OR type = ANY($6::text[]))
  ORDER BY scheduled_at DESC
  LIMIT $5
`;

interface Row {
  id: string;
  source: string;
  type: string;
  asset_tags: string[];
  scheduled_at: Date;
  published_at: Date;
  fetched_at: Date;
  payload: Record<string, unknown>;
  content_hash: string;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return MAX_EVENTS_LIMIT;
  return Math.min(Math.max(1, Math.trunc(limit)), MAX_EVENTS_LIMIT);
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
}

export function createEventsRepository(db: Queryable): EventsRepository {
  return {
    async upsertEvents(events: readonly MarketEventInput[]): Promise<number> {
      if (events.length === 0) return 0;

      let affected = 0;
      for (const batch of chunk(events, UPSERT_BATCH_SIZE)) {
        const rows = batch.map((event) => ({
          source: event.source,
          type: event.type,
          asset_tags: event.assetTags,
          scheduled_at: new Date(event.scheduledAt).toISOString(),
          published_at: new Date(event.publishedAt).toISOString(),
          fetched_at: new Date(event.fetchedAt).toISOString(),
          payload: event.payload,
          content_hash: eventContentHash(event),
        }));
        const result = await db.query(UPSERT_SQL, [JSON.stringify(rows)]);
        affected += result.rowCount ?? 0;
      }
      return affected;
    },

    async getEvents(query: EventsRangeQuery): Promise<StoredMarketEvent[]> {
      const { rows } = await db.query<Row>(SELECT_SQL, [
        new Date(query.from),
        new Date(query.to),
        query.tags === undefined || query.tags.length === 0 ? null : [...query.tags],
        query.asOf === undefined ? null : new Date(query.asOf),
        clampLimit(query.limit),
        query.types === undefined || query.types.length === 0 ? null : [...query.types],
      ]);

      return rows.map((row) => ({
        id: row.id,
        source: row.source,
        type: row.type,
        assetTags: row.asset_tags,
        scheduledAt: row.scheduled_at.getTime(),
        publishedAt: row.published_at.getTime(),
        fetchedAt: row.fetched_at.getTime(),
        payload: row.payload,
        contentHash: row.content_hash,
      }));
    },
  };
}
