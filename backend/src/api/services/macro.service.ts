import {
  EVENTS_MAX_LIMIT,
  MACRO_MAX_LIMIT,
  type EventsResponse,
  type MacroSeriesResponse,
} from '@tt/shared';
import type { EventsRepository } from '../../db/repositories/events.repo.js';
import type { MacroRepository } from '../../db/repositories/macro.repo.js';
import type { AppLogger } from '../../observability/logger.js';
import { AppError } from '../errors.js';
import { cached, eventsKey, MACRO_TTL_SEC, macroKey, type CacheStore } from './cache.js';

export interface MacroServiceDeps {
  readonly macro: MacroRepository;
  readonly events: EventsRepository;
  readonly cache: CacheStore;
  readonly logger: AppLogger;
  readonly now: () => number;
}

export interface MacroSeriesRequest {
  readonly seriesId: string;
  readonly from: number;
  readonly to?: number | undefined;
  readonly asOf?: number | undefined;
  readonly source?: string | undefined;
  readonly limit?: number | undefined;
}

export interface EventsRequest {
  readonly from: number;
  readonly to?: number | undefined;
  readonly asOf?: number | undefined;
  readonly asset?: readonly string[] | undefined;
  readonly limit?: number | undefined;
}

interface Scope {
  readonly to: number;
  readonly limit: number;
}

/** Mismo contrato que `/api/candles`: tope duro de filas y `to` posterior a `from`. */
function scopeOf(
  request: { from: number; to?: number | undefined; limit?: number | undefined },
  maxLimit: number,
  now: () => number,
): Scope {
  const limit = request.limit ?? maxLimit;
  if (limit > maxLimit) {
    throw AppError.rangeTooLarge(`limit maximo ${maxLimit}, se pidieron ${limit}`);
  }

  const to = request.to ?? now();
  if (to <= request.from) {
    throw AppError.validation('El rango esta vacio', [
      { path: 'query.to', message: 'to debe ser mayor que from' },
    ]);
  }

  return { to, limit };
}

export async function getMacroSeries(
  deps: MacroServiceDeps,
  request: MacroSeriesRequest,
): Promise<MacroSeriesResponse> {
  const scope = scopeOf(request, MACRO_MAX_LIMIT, deps.now);

  // La PK de `macro_series` es (source, series_id, ts, revision), asi que la serie sola puede ser
  // ambigua. Se resuelve contra la tabla en vez de con un catalogo duplicado en el API.
  const sources = await deps.macro.getSources(request.seriesId);
  if (sources.length === 0) {
    throw AppError.notFound(`No hay serie macro con id ${request.seriesId}`);
  }

  let source = request.source ?? sources[0];
  if (request.source !== undefined) {
    if (!sources.includes(request.source)) {
      throw AppError.notFound(
        `La fuente ${request.source} no publica la serie ${request.seriesId}`,
      );
    }
    source = request.source;
  } else if (sources.length > 1) {
    throw AppError.validation(`La serie ${request.seriesId} la publican varias fuentes`, [
      { path: 'query.source', message: `elige una: ${sources.join(', ')}` },
    ]);
  }
  if (source === undefined) {
    throw AppError.notFound(`No hay serie macro con id ${request.seriesId}`);
  }

  const resolved = source;

  return cached<MacroSeriesResponse>({
    cache: deps.cache,
    logger: deps.logger,
    // `asOf` va en la clave: sin el, una consulta point-in-time serviria la respuesta de otra.
    key: macroKey(resolved, request.seriesId, request.from, scope.to, scope.limit, request.asOf),
    ttlSec: MACRO_TTL_SEC,
    parse: (raw) => JSON.parse(raw) as MacroSeriesResponse,
    load: async () => {
      const points = await deps.macro.getPoints({
        source: resolved,
        seriesId: request.seriesId,
        from: request.from,
        to: scope.to,
        limit: scope.limit,
        ...(request.asOf === undefined ? {} : { asOf: request.asOf }),
      });

      const last = points.at(-1);
      return {
        source: resolved,
        seriesId: request.seriesId,
        count: points.length,
        points,
        asOf: request.asOf ?? null,
        // Un milisegundo, no un paso: una serie macro no tiene rejilla fija (diaria, semanal,
        // trimestral), asi que no hay paso que sumar.
        nextFrom: points.length === scope.limit && last !== undefined ? last.t + 1 : null,
      };
    },
  });
}

export async function getMarketEvents(
  deps: MacroServiceDeps,
  request: EventsRequest,
): Promise<EventsResponse> {
  const scope = scopeOf(request, EVENTS_MAX_LIMIT, deps.now);
  const tags = request.asset ?? [];

  return cached<EventsResponse>({
    cache: deps.cache,
    logger: deps.logger,
    key: eventsKey(request.from, scope.to, scope.limit, tags, request.asOf),
    ttlSec: MACRO_TTL_SEC,
    parse: (raw) => JSON.parse(raw) as EventsResponse,
    load: async () => {
      const events = await deps.events.getEvents({
        from: request.from,
        to: scope.to,
        limit: scope.limit,
        ...(tags.length === 0 ? {} : { tags }),
        ...(request.asOf === undefined ? {} : { asOf: request.asOf }),
      });

      const last = events.at(-1);
      return {
        count: events.length,
        events: events.map((event) => ({
          id: event.id,
          source: event.source,
          type: event.type,
          assetTags: [...event.assetTags],
          scheduledAt: event.scheduledAt,
          publishedAt: event.publishedAt,
          fetchedAt: event.fetchedAt,
          payload: event.payload,
        })),
        asOf: request.asOf ?? null,
        // El repositorio sirve del mas reciente al mas antiguo, asi que se pagina hacia atras.
        nextTo: events.length === scope.limit && last !== undefined ? last.scheduledAt - 1 : null,
      };
    },
  });
}
