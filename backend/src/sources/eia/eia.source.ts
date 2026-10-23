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
import type { EiaClient } from './client.js';
import {
  EIA_EVENT_TAGS,
  EIA_REPORT_EVENT_TYPE,
  EIA_SOURCE_ID,
  eiaStocksSchema,
  releaseInstant,
  toTimestamp,
} from './types.js';

export interface EiaDiscard {
  seriesId: string;
  period: string;
  reason: string;
}

export interface EiaSourceOptions {
  pool: Pool;
  client: EiaClient;
  seriesIds: readonly string[];
  schedule: string;
  start: string;
  onDiscard?: ((discard: EiaDiscard) => void) | undefined;
  macroRepo?: MacroRepository | undefined;
  eventsRepo?: EventsRepository | undefined;
}

export interface EiaRaw {
  fetchedAt: number;
  body: unknown;
}

interface StockItem extends SourceItem {
  kind: 'stock';
  seriesId: string;
  t: number;
  value: number;
}

interface ReportItem extends SourceItem {
  kind: 'report';
  period: string;
  scheduledAt: number;
}

export type EiaItem = StockItem | ReportItem;

export function createEiaSource(options: EiaSourceOptions): SourceAdapter<EiaRaw, EiaItem> {
  const macroRepo = options.macroRepo ?? createMacroRepository(options.pool);
  const eventsRepo = options.eventsRepo ?? createEventsRepository(options.pool);

  return {
    id: EIA_SOURCE_ID,
    schedule: options.schedule,
    requiredEnv: ['EIA_API_KEY'],

    async fetch(_since: Date | null, context: SourceContext): Promise<EiaRaw> {
      const fetchedAt = context.now();
      await context.limiter.acquire();

      // `since` se ignora a proposito: la EIA corrige inventarios de semanas ya publicadas, asi
      // que cada pasada pide desde `start` y la revision se resuelve al persistir.
      return {
        fetchedAt,
        body: await options.client.getWeeklyStocks(options.seriesIds, options.start),
      };
    },

    normalize(raw: EiaRaw): NormalizedBatch<EiaItem> {
      // Un cambio de forma de la API tiene que ser ruidoso: no se descarta en silencio.
      const { response } = eiaStocksSchema.parse(raw.body);
      const items: EiaItem[] = [];
      const periods = new Set<string>();
      let discarded = 0;

      for (const row of response.data) {
        if (row.value === null) {
          discarded += 1;
          options.onDiscard?.({
            seriesId: row.series,
            period: row.period,
            reason: 'valor ausente: la EIA lo publica como null',
          });
          continue;
        }

        const t = toTimestamp(row.period);
        periods.add(row.period);
        items.push({
          kind: 'stock',
          seriesId: row.series,
          t,
          value: row.value,
          // La EIA no expone cuando publico la fila, asi que se usa el instante anunciado del
          // informe que la trae: antes de ese miercoles el dato no existia.
          publishedAt: releaseInstant(t),
          fetchedAt: raw.fetchedAt,
        });
      }

      for (const period of periods) {
        const scheduledAt = releaseInstant(toTimestamp(period));
        items.push({
          kind: 'report',
          period,
          scheduledAt,
          // Su propia fecha anunciada, porque entra en el `content_hash` y tiene que ser estable:
          // con `fetchedAt` el mismo informe se duplicaria en cada pasada.
          publishedAt: scheduledAt,
          fetchedAt: raw.fetchedAt,
        });
      }

      return { sourceId: EIA_SOURCE_ID, items, discarded };
    },

    async persist(batch: NormalizedBatch<EiaItem>): Promise<PersistResult> {
      const bySeries = new Map<string, StockItem[]>();
      const events: MarketEventInput[] = [];

      for (const item of batch.items) {
        if (item.kind === 'report') {
          events.push({
            source: EIA_SOURCE_ID,
            type: EIA_REPORT_EVENT_TYPE,
            assetTags: EIA_EVENT_TAGS,
            scheduledAt: item.scheduledAt,
            publishedAt: item.publishedAt,
            fetchedAt: item.fetchedAt,
            payload: { report: 'weekly-petroleum-status', period: item.period },
          });
          continue;
        }

        const group = bySeries.get(item.seriesId);
        if (group === undefined) bySeries.set(item.seriesId, [item]);
        else group.push(item);
      }

      let written = 0;
      for (const [seriesId, group] of bySeries) {
        written += await macroRepo.upsertPoints({
          source: EIA_SOURCE_ID,
          seriesId,
          points: await withRevisions(macroRepo, seriesId, group),
        });
      }
      written += await eventsRepo.upsertEvents(events);

      return { written, skipped: batch.items.length - written };
    },
  };
}

/**
 * La EIA solo sirve el valor vigente de cada semana, sin vintages: el numero de revision no viene
 * en la respuesta y hay que deducirlo de lo ya guardado. Un valor igual al ultimo conocido no se
 * reescribe (de ahi la idempotencia) y uno distinto entra como la revision siguiente, conviviendo
 * con el original en vez de sobrescribirlo.
 */
async function withRevisions(
  macroRepo: MacroRepository,
  seriesId: string,
  items: readonly StockItem[],
): Promise<MacroPoint[]> {
  const timestamps = items.map((item) => item.t);
  const stored = new Map<number, MacroPoint>();

  if (timestamps.length > 0) {
    const points = await macroRepo.getPoints({
      source: EIA_SOURCE_ID,
      seriesId,
      from: Math.min(...timestamps),
      to: Math.max(...timestamps),
    });
    for (const point of points) stored.set(point.t, point);
  }

  const result: MacroPoint[] = [];
  for (const item of items) {
    const last = stored.get(item.t);
    if (last?.value === item.value) continue;
    result.push({
      t: item.t,
      value: item.value,
      publishedAt: item.publishedAt,
      fetchedAt: item.fetchedAt,
      revision: last === undefined ? 0 : last.revision + 1,
    });
  }
  return result;
}
