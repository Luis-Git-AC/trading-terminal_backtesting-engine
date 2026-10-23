import type { Queryable } from './candles.repo.js';

export const MAX_MACRO_LIMIT = 5000;
export const UPSERT_BATCH_SIZE = 1000;

export interface MacroSeriesRef {
  source: string;
  seriesId: string;
}

/** Un punto de una serie macro. `revision` 0 es la primera publicacion; cada correccion sube una. */
export interface MacroPoint {
  t: number;
  value: number;
  publishedAt: number;
  fetchedAt: number;
  revision: number;
}

export interface UpsertMacroInput extends MacroSeriesRef {
  points: readonly MacroPoint[];
}

export interface MacroRangeQuery extends MacroSeriesRef {
  from: number;
  to: number;
  /**
   * Corte point-in-time (ADR-006): devuelve la revision mas alta que ya estaba descargada en ese
   * instante, que es lo que se sabia entonces. Sin el, la ultima conocida.
   */
  asOf?: number | undefined;
  limit?: number | undefined;
}

export interface MacroRepository {
  upsertPoints(input: UpsertMacroInput): Promise<number>;
  getPoints(query: MacroRangeQuery): Promise<MacroPoint[]>;
  getLastTs(ref: MacroSeriesRef): Promise<number | null>;
  /**
   * Instante de publicacion mas reciente ya guardado. Es el que deja reanudar una fuente que sirve
   * vintages (el FRED) sin volver a pedir todo el historico de revisiones.
   */
  getLastPublishedAt(ref: MacroSeriesRef): Promise<number | null>;
  /**
   * Revision mas alta guardada de cada una de esas fechas. Es lo que deja continuar la numeracion
   * de una fuente que sirve vintages sin traerse la serie entera a memoria.
   */
  getMaxRevisions(ref: MacroSeriesRef, timestamps: readonly number[]): Promise<Map<number, number>>;
  /** Las fuentes que publican esa serie. Vacio = la serie no existe. */
  getSources(seriesId: string): Promise<string[]>;
}

const UPSERT_SQL = `
  INSERT INTO macro_series (source, series_id, ts, value, published_at, fetched_at, revision)
  SELECT $1, $2, point.ts, point.value, point.published_at, point.fetched_at, point.revision
  FROM unnest($3::timestamptz[], $4::numeric[], $5::timestamptz[], $6::timestamptz[], $7::int[])
    AS point(ts, value, published_at, fetched_at, revision)
  ON CONFLICT (source, series_id, ts, revision) DO NOTHING
`;

// DISTINCT ON se queda con la primera fila de cada ts, y el ORDER BY pone delante la revision mas
// alta: la correccion mas reciente que cumpla el corte, sin borrar las anteriores.
const SELECT_SQL = `
  SELECT DISTINCT ON (ts) ts, value, published_at, fetched_at, revision
  FROM macro_series
  WHERE source = $1
    AND series_id = $2
    AND ts >= $3
    AND ts <= $4
    AND ($5::timestamptz IS NULL OR fetched_at <= $5)
  ORDER BY ts, revision DESC
  LIMIT $6
`;

const SOURCES_SQL = `
  SELECT DISTINCT source FROM macro_series WHERE series_id = $1 ORDER BY source
`;

const LAST_TS_SQL = `
  SELECT max(ts) AS ts FROM macro_series WHERE source = $1 AND series_id = $2
`;

const MAX_REVISIONS_SQL = `
  SELECT ts, max(revision) AS revision
  FROM macro_series
  WHERE source = $1 AND series_id = $2 AND ts = ANY($3::timestamptz[])
  GROUP BY ts
`;

const LAST_PUBLISHED_SQL = `
  SELECT max(published_at) AS published_at FROM macro_series WHERE source = $1 AND series_id = $2
`;

interface Row {
  ts: Date;
  value: string;
  published_at: Date;
  fetched_at: Date;
  revision: number;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return MAX_MACRO_LIMIT;
  return Math.min(Math.max(1, Math.trunc(limit)), MAX_MACRO_LIMIT);
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
}

export function createMacroRepository(db: Queryable): MacroRepository {
  return {
    async upsertPoints({ source, seriesId, points }: UpsertMacroInput): Promise<number> {
      if (points.length === 0) return 0;

      let affected = 0;
      for (const batch of chunk(points, UPSERT_BATCH_SIZE)) {
        const result = await db.query(UPSERT_SQL, [
          source,
          seriesId,
          batch.map((point) => new Date(point.t)),
          batch.map((point) => String(point.value)),
          batch.map((point) => new Date(point.publishedAt)),
          batch.map((point) => new Date(point.fetchedAt)),
          batch.map((point) => point.revision),
        ]);
        affected += result.rowCount ?? 0;
      }
      return affected;
    },

    async getPoints(query: MacroRangeQuery): Promise<MacroPoint[]> {
      const { rows } = await db.query<Row>(SELECT_SQL, [
        query.source,
        query.seriesId,
        new Date(query.from),
        new Date(query.to),
        query.asOf === undefined ? null : new Date(query.asOf),
        clampLimit(query.limit),
      ]);

      return rows.map((row) => ({
        t: row.ts.getTime(),
        value: Number(row.value),
        publishedAt: row.published_at.getTime(),
        fetchedAt: row.fetched_at.getTime(),
        revision: row.revision,
      }));
    },

    async getLastTs({ source, seriesId }: MacroSeriesRef): Promise<number | null> {
      const { rows } = await db.query<{ ts: Date | null }>(LAST_TS_SQL, [source, seriesId]);
      return rows[0]?.ts?.getTime() ?? null;
    },

    async getLastPublishedAt({ source, seriesId }: MacroSeriesRef): Promise<number | null> {
      const { rows } = await db.query<{ published_at: Date | null }>(LAST_PUBLISHED_SQL, [
        source,
        seriesId,
      ]);
      return rows[0]?.published_at?.getTime() ?? null;
    },

    async getMaxRevisions(
      { source, seriesId }: MacroSeriesRef,
      timestamps: readonly number[],
    ): Promise<Map<number, number>> {
      if (timestamps.length === 0) return new Map();

      const { rows } = await db.query<{ ts: Date; revision: number }>(MAX_REVISIONS_SQL, [
        source,
        seriesId,
        timestamps.map((ts) => new Date(ts)),
      ]);
      return new Map(rows.map((row) => [row.ts.getTime(), row.revision]));
    },

    async getSources(seriesId: string): Promise<string[]> {
      const { rows } = await db.query<{ source: string }>(SOURCES_SQL, [seriesId]);
      return rows.map((row) => row.source);
    },
  };
}
