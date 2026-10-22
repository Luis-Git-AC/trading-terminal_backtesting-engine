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
  FRED_RELEASE_EVENT_TYPE,
  FRED_SOURCE_ID,
  fredObservationsSchema,
  fredReleaseDatesSchema,
  toTimestamp,
  type FredObservation,
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
  series: readonly { seriesId: string; body: unknown }[];
  releases: unknown;
}

interface ObservationItem extends SourceItem {
  kind: 'observation';
  seriesId: string;
  t: number;
  value: number;
  revision: number;
}

interface ReleaseItem extends SourceItem {
  kind: 'release';
  scheduledAt: number;
  releaseId: number;
  releaseName: string;
}

export type FredItem = ObservationItem | ReleaseItem;

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Las revisiones de una misma fecha de observacion, ordenadas por `realtime_start`: la posicion es
 * el numero de revision. Exige la ventana realtime completa, que es lo que pide el cliente.
 */
function numberRevisions(observations: readonly FredObservation[]): Map<FredObservation, number> {
  const byDate = new Map<string, FredObservation[]>();
  for (const observation of observations) {
    const group = byDate.get(observation.date);
    if (group === undefined) byDate.set(observation.date, [observation]);
    else group.push(observation);
  }

  const revisions = new Map<FredObservation, number>();
  for (const group of byDate.values()) {
    const sorted = [...group].sort((a, b) =>
      a.realtime_start < b.realtime_start ? -1 : a.realtime_start > b.realtime_start ? 1 : 0,
    );
    sorted.forEach((observation, index) => revisions.set(observation, index));
  }
  return revisions;
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

  return {
    id: FRED_SOURCE_ID,
    schedule: options.schedule,
    requiredEnv: ['FRED_API_KEY'],

    async fetch(_since: Date | null, context: SourceContext): Promise<FredRaw> {
      const fetchedAt = context.now();
      const series: { seriesId: string; body: unknown }[] = [];

      // `since` se ignora a proposito: una revision del FRED aterriza sobre una fecha de
      // observacion vieja, asi que una ventana incremental se la dejaria fuera. Cada pasada pide
      // la serie entera desde `observationStart`, y el upsert se encarga de no duplicar.
      for (const seriesId of options.seriesIds) {
        await context.limiter.acquire();
        series.push({
          seriesId,
          body: await options.client.getObservations(seriesId, options.observationStart),
        });
      }

      await context.limiter.acquire();
      const releases = await options.client.getReleaseDates(isoDay(fetchedAt - RELEASE_LOOKBACK_MS));

      return { fetchedAt, series, releases };
    },

    normalize(raw: FredRaw): NormalizedBatch<FredItem> {
      const items: FredItem[] = [];
      let discarded = 0;

      for (const { seriesId, body } of raw.series) {
        // Un cambio de forma de la API tiene que ser ruidoso: no se descarta en silencio.
        const { observations } = fredObservationsSchema.parse(body);
        const revisions = numberRevisions(observations);

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
            revision: revisions.get(observation) ?? 0,
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
      const bySeries = new Map<string, MacroPoint[]>();
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
        const point: MacroPoint = {
          t: item.t,
          value: item.value,
          publishedAt: item.publishedAt,
          fetchedAt: item.fetchedAt,
          revision: item.revision,
        };
        if (points === undefined) bySeries.set(item.seriesId, [point]);
        else points.push(point);
      }

      let written = 0;
      for (const [seriesId, points] of bySeries) {
        written += await macroRepo.upsertPoints({ source: FRED_SOURCE_ID, seriesId, points });
      }
      written += await eventsRepo.upsertEvents(events);

      return { written, skipped: batch.items.length - written };
    },
  };
}
