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
import type { CftcClient } from './client.js';
import {
  CFTC_EVENT_TAGS,
  CFTC_FIELD,
  CFTC_MARKETS,
  CFTC_REPORT_EVENT_TYPE,
  CFTC_SOURCE_ID,
  cftcRowSchema,
  contractCodeOf,
  publicationInstant,
  splitRow,
  toTimestamp,
} from './types.js';

export interface CftcSourceOptions {
  pool: Pool;
  client: CftcClient;
  schedule: string;
  macroRepo?: MacroRepository | undefined;
  eventsRepo?: EventsRepository | undefined;
}

export interface CftcRaw {
  fetchedAt: number;
  /** Solo las filas de los mercados seguidos, tal cual llegaron. */
  lines: readonly string[];
  /** Filas leidas del fichero, para que el report diga cuanto se descarto por no interesar. */
  scanned: number;
}

interface PositionItem extends SourceItem {
  kind: 'position';
  seriesId: string;
  marketName: string;
  t: number;
  value: number;
  openInterest: number;
}

interface ReportItem extends SourceItem {
  kind: 'report';
  reportDate: string;
  scheduledAt: number;
}

export type CftcItem = PositionItem | ReportItem;

export function createCftcSource(options: CftcSourceOptions): SourceAdapter<CftcRaw, CftcItem> {
  const macroRepo = options.macroRepo ?? createMacroRepository(options.pool);
  const eventsRepo = options.eventsRepo ?? createEventsRepository(options.pool);

  return {
    id: CFTC_SOURCE_ID,
    schedule: options.schedule,
    requiredEnv: [],

    async fetch(_since: Date | null, context: SourceContext): Promise<CftcRaw> {
      const fetchedAt = context.now();
      await context.limiter.acquire();

      // El filtrado va aqui, mientras se lee: de las ~370 filas del informe solo tres interesan,
      // y quedarse el fichero entero para filtrarlo despues es justo lo que el ticket prohibe.
      const lines: string[] = [];
      let scanned = 0;

      for await (const line of options.client.streamLines()) {
        scanned += 1;
        const code = contractCodeOf(line);
        if (code !== null && code in CFTC_MARKETS) lines.push(line);
      }

      return { fetchedAt, lines, scanned };
    },

    normalize(raw: CftcRaw): NormalizedBatch<CftcItem> {
      const items: CftcItem[] = [];
      const reportDates = new Set<string>();

      for (const line of raw.lines) {
        const row = splitRow(line);
        if (row === null) {
          throw new Error(`fila de la CFTC ilegible: ${line.slice(0, 80)}`);
        }

        // Las tres filas se eligieron por codigo de contrato, asi que una de ellas con otra forma
        // es un cambio del formato del informe: tiene que ser ruidoso, no un descarte silencioso.
        const parsed = cftcRowSchema.parse({
          marketName: row.marketName,
          reportDate: row.fields[CFTC_FIELD.reportDate]?.trim(),
          contractCode: row.fields[CFTC_FIELD.contractCode]?.trim(),
          openInterest: row.fields[CFTC_FIELD.openInterest],
          noncommercialLong: row.fields[CFTC_FIELD.noncommercialLong],
          noncommercialShort: row.fields[CFTC_FIELD.noncommercialShort],
        });

        const market = CFTC_MARKETS[parsed.contractCode];
        if (market === undefined) continue;

        const t = toTimestamp(parsed.reportDate);
        reportDates.add(parsed.reportDate);
        items.push({
          kind: 'position',
          seriesId: market.seriesId,
          marketName: parsed.marketName,
          t,
          value: parsed.noncommercialLong - parsed.noncommercialShort,
          openInterest: parsed.openInterest,
          // Tres dias despues del martes del informe: hasta ese viernes el dato no existia.
          publishedAt: publicationInstant(t),
          fetchedAt: raw.fetchedAt,
        });
      }

      for (const reportDate of reportDates) {
        const scheduledAt = toTimestamp(reportDate);
        items.push({
          kind: 'report',
          reportDate,
          scheduledAt,
          publishedAt: publicationInstant(scheduledAt),
          fetchedAt: raw.fetchedAt,
        });
      }

      return { sourceId: CFTC_SOURCE_ID, items, discarded: raw.scanned - raw.lines.length };
    },

    async persist(batch: NormalizedBatch<CftcItem>): Promise<PersistResult> {
      const bySeries = new Map<string, MacroPoint[]>();
      const events: MarketEventInput[] = [];

      for (const item of batch.items) {
        if (item.kind === 'report') {
          events.push({
            source: CFTC_SOURCE_ID,
            type: CFTC_REPORT_EVENT_TYPE,
            assetTags: CFTC_EVENT_TAGS,
            scheduledAt: item.scheduledAt,
            publishedAt: item.publishedAt,
            fetchedAt: item.fetchedAt,
            payload: { report: 'legacy-futures-only', reportDate: item.reportDate },
          });
          continue;
        }

        // Revision 0 siempre: la CFTC no corrige un informe publicado, publica el de la semana
        // siguiente. Un reproceso de la misma semana choca con la PK y no escribe nada.
        const point: MacroPoint = {
          t: item.t,
          value: item.value,
          publishedAt: item.publishedAt,
          fetchedAt: item.fetchedAt,
          revision: 0,
        };
        const points = bySeries.get(item.seriesId);
        if (points === undefined) bySeries.set(item.seriesId, [point]);
        else points.push(point);
      }

      let written = 0;
      for (const [seriesId, points] of bySeries) {
        written += await macroRepo.upsertPoints({ source: CFTC_SOURCE_ID, seriesId, points });
      }
      written += await eventsRepo.upsertEvents(events);

      return { written, skipped: batch.items.length - written };
    },
  };
}
