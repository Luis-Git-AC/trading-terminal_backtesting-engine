import type { Pool } from 'pg';
import {
  createEventsRepository,
  type EventsRepository,
  type MarketEventInput,
} from '../../db/repositories/events.repo.js';
import {
  createMacroRepository,
  type MacroPoint,
  type MacroRepository,
} from '../../db/repositories/macro.repo.js';
import type {
  NormalizedBatch,
  PersistResult,
  SourceAdapter,
  SourceContext,
  SourceItem,
} from '../adapter.js';
import type { FredClient } from './client.js';
import {
  FRED_EVENT_TAGS,
  FRED_REALTIME_END,
  FRED_RELEASE_EVENT_TYPE,
  FRED_SOURCE_ID,
  FRED_VINTAGES_PER_REQUEST,
  fredObservationsSchema,
  fredReleaseDatesSchema,
  fredVintageDatesSchema,
  toTimestamp,
} from './types.js';

/** Cuanto calendario de publicaciones se pide hacia atras; hacia delante va hasta donde haya. */
export const RELEASE_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

export interface FredDiscard {
  seriesId: string;
  date: string;
  value: string;
  reason: string;
}

export interface FredSourceOptions {
  pool: Pool;
  client: FredClient;
  seriesIds: readonly string[];
  schedule: string;
  observationStart: string;
  onDiscard?: ((discard: FredDiscard) => void) | undefined;
  macroRepo?: MacroRepository | undefined;
  eventsRepo?: EventsRepository | undefined;
}

export interface FredRaw {
  fetchedAt: number;
  /** Un cuerpo por tramo de vintages: una serie larga no cabe en una sola peticion. */
  series: readonly { seriesId: string; bodies: readonly unknown[] }[];
  releases: unknown;
}

interface ObservationItem extends SourceItem {
  kind: 'observation';
  seriesId: string;
  t: number;
  value: number;
}

interface ReleaseItem extends SourceItem {
  kind: 'release';
  scheduledAt: number;
  releaseId: number;
  releaseName: string;
}

export type FredItem = ObservationItem | ReleaseItem;

type Observation = Omit<MacroPoint, 'revision'>;

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
}

function discardReason(value: string): string | null {
  if (value === '.') return 'valor ausente: el FRED lo publica como "."';
  if (!Number.isFinite(Number(value))) return `valor no numerico: ${JSON.stringify(value)}`;
  return null;
}

export function createFredSource(
  options: FredSourceOptions,
): SourceAdapter<FredRaw, FredItem> {
  const macroRepo = options.macroRepo ?? createMacroRepository(options.pool);
  const eventsRepo = options.eventsRepo ?? createEventsRepository(options.pool);

  /**
   * Numera las revisiones con las fechas de vintage, que es lo que el FRED si publica. No vale la
   * regla por valor de `withRevisions` (la de las fuentes sin vintages): la ventana troceada
   * reserve vintages ya guardados, y compararlos por valor los volveria a meter como correcciones.
   */
  async function numberRevisions(
    seriesId: string,
    observations: readonly Observation[],
  ): Promise<MacroPoint[]> {
    const ref = { source: FRED_SOURCE_ID, seriesId };
    const lastPublishedAt = await macroRepo.getLastPublishedAt(ref);

    // Un vintage que no es posterior al ultimo guardado ya se conoce. El FRED recorta el
    // `realtime_start` al inicio de la ventana, asi que en una pasada incremental los valores sin
    // cambios vuelven con la fecha del corte: por ahi se van sin tocar nada.
    const fresh = [...observations]
      .filter((item) => lastPublishedAt === null || item.publishedAt > lastPublishedAt)
      .sort((a, b) => a.t - b.t || a.publishedAt - b.publishedAt);

    const stored = await macroRepo.getMaxRevisions(
      ref,
      fresh.map((item) => item.t),
    );

    return fresh.map((item) => {
      const last = stored.get(item.t);
      const revision = last === undefined ? 0 : last + 1;
      // Dos vintages de la misma fecha en la misma pasada son dos revisiones consecutivas.
      stored.set(item.t, revision);
      return { ...item, revision };
    });
  }

  return {
    id: FRED_SOURCE_ID,
    schedule: options.schedule,
    requiredEnv: ['FRED_API_KEY'],

    async fetch(_since: Date | null, context: SourceContext): Promise<FredRaw> {
      const fetchedAt = context.now();
      const series: { seriesId: string; bodies: unknown[] }[] = [];

      // `since` se ignora a proposito: una revision del FRED aterriza sobre una fecha de
      // observacion vieja, asi que una ventana por fecha de observacion se la dejaria fuera. Lo
      // que avanza es la ventana de **vintages**, que es donde aparece la correccion.
      for (const seriesId of options.seriesIds) {
        const lastPublishedAt = await macroRepo.getLastPublishedAt({
          source: FRED_SOURCE_ID,
          seriesId,
        });
        const from = lastPublishedAt === null ? options.observationStart : isoDay(lastPublishedAt);

        await context.limiter.acquire();
        const { vintage_dates: vintages } = fredVintageDatesSchema.parse(
          await options.client.getVintageDates(seriesId, from),
        );

        // Trocear por vintages y no por fechas de observacion: el tope del FRED cuenta vintages, y
        // una serie diaria estrena uno cada dia habil.
        const bodies: unknown[] = [];
        for (const window of chunk(vintages, FRED_VINTAGES_PER_REQUEST)) {
          const first = window[0];
          if (first === undefined) continue;
          await context.limiter.acquire();
          bodies.push(
            await options.client.getObservations(
              seriesId,
              options.observationStart,
              first,
              // El ultimo tramo queda abierto para que entren los vintages de hoy.
              window.length < FRED_VINTAGES_PER_REQUEST
                ? FRED_REALTIME_END
                : (window.at(-1) ?? FRED_REALTIME_END),
            ),
          );
        }

        series.push({ seriesId, bodies });
      }

      await context.limiter.acquire();
      const releases = await options.client.getReleaseDates(isoDay(fetchedAt - RELEASE_LOOKBACK_MS));

      return { fetchedAt, series, releases };
    },

    normalize(raw: FredRaw): NormalizedBatch<FredItem> {
      const items: FredItem[] = [];
      let discarded = 0;

      for (const { seriesId, bodies } of raw.series) {
        // Un cambio de forma de la API tiene que ser ruidoso: no se descarta en silencio.
        const observations = bodies.flatMap(
          (body) => fredObservationsSchema.parse(body).observations,
        );

        for (const observation of observations) {
          const reason = discardReason(observation.value);
          if (reason !== null) {
            discarded += 1;
            options.onDiscard?.({
              seriesId,
              date: observation.date,
              value: observation.value,
              reason,
            });
            continue;
          }

          items.push({
            kind: 'observation',
            seriesId,
            t: toTimestamp(observation.date),
            value: Number(observation.value),
            publishedAt: toTimestamp(observation.realtime_start),
            fetchedAt: raw.fetchedAt,
          });
        }
      }

      const { release_dates: releaseDates } = fredReleaseDatesSchema.parse(raw.releases);
      for (const release of releaseDates) {
        const scheduledAt = toTimestamp(release.date);
        items.push({
          kind: 'release',
          scheduledAt,
          releaseId: release.release_id,
          releaseName: release.release_name ?? `release ${release.release_id}`,
          // El FRED no dice cuando publico la entrada del calendario. Se usa la propia fecha del
          // release porque entra en el `content_hash` y tiene que ser estable: con `fetchedAt` el
          // mismo evento se duplicaria en cada pasada. El corte point-in-time lo da `fetched_at`.
          publishedAt: scheduledAt,
          fetchedAt: raw.fetchedAt,
        });
      }

      return { sourceId: FRED_SOURCE_ID, items, discarded };
    },

    async persist(batch: NormalizedBatch<FredItem>): Promise<PersistResult> {
      const bySeries = new Map<string, Observation[]>();
      const events: MarketEventInput[] = [];

      for (const item of batch.items) {
        if (item.kind === 'release') {
          events.push({
            source: FRED_SOURCE_ID,
            type: FRED_RELEASE_EVENT_TYPE,
            assetTags: FRED_EVENT_TAGS,
            scheduledAt: item.scheduledAt,
            publishedAt: item.publishedAt,
            fetchedAt: item.fetchedAt,
            payload: { releaseId: item.releaseId, releaseName: item.releaseName },
          });
          continue;
        }

        const points = bySeries.get(item.seriesId);
        const point: Observation = {
          t: item.t,
          value: item.value,
          publishedAt: item.publishedAt,
          fetchedAt: item.fetchedAt,
        };
        if (points === undefined) bySeries.set(item.seriesId, [point]);
        else points.push(point);
      }

      let written = 0;
      for (const [seriesId, observations] of bySeries) {
        const points = await numberRevisions(seriesId, observations);
        written += await macroRepo.upsertPoints({ source: FRED_SOURCE_ID, seriesId, points });
      }
      written += await eventsRepo.upsertEvents(events);

      return { written, skipped: batch.items.length - written };
    },
  };
}
