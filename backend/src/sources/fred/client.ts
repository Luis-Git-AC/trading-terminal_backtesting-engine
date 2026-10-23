import type { FetchLike } from '../../ingest/exchange/adapter.js';
import { UpstreamError } from '../../ingest/exchange/errors.js';
import {
  FRED_OBSERVATIONS_PATH,
  FRED_REALTIME_END,
  FRED_RELEASE_DATES_LIMIT,
  FRED_RELEASE_DATES_PATH,
  FRED_VINTAGE_DATES_LIMIT,
  FRED_VINTAGE_DATES_PATH,
  fredErrorSchema,
} from './types.js';

export interface FredClientOptions {
  apiKey: string;
  baseUrl: string;
  fetch: FetchLike;
}

export interface FredClient {
  /**
   * Crudo, sin tocar: la validacion es de `normalize` (ADR-006, raw inmutable). La ventana realtime
   * la pone quien llama porque el tope de vintages obliga a trocearla.
   */
  getObservations(
    seriesId: string,
    observationStart: string,
    realtimeStart: string,
    realtimeEnd: string,
  ): Promise<unknown>;
  /** Fechas de vintage de la serie desde `from`: son las que marcan por donde trocear. */
  getVintageDates(seriesId: string, from: string): Promise<unknown>;
  getReleaseDates(from: string): Promise<unknown>;
}

function buildUrl(baseUrl: string, path: string, params: Record<string, string>): string {
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

/** El cuerpo de error del FRED si viene; si no, el status a secas. */
function describeFailure(status: number, body: unknown): string {
  const parsed = fredErrorSchema.safeParse(body);
  if (!parsed.success) return `el FRED respondio ${status}`;
  return `el FRED respondio ${status}: ${parsed.data.error_code} ${parsed.data.error_message}`;
}

export function createFredClient(options: FredClientOptions): FredClient {
  async function get(path: string, params: Record<string, string>): Promise<unknown> {
    const url = buildUrl(options.baseUrl, path, {
      ...params,
      api_key: options.apiKey,
      file_type: 'json',
    });

    const response = await options.fetch(url);
    // El cuerpo se lee tambien en el error: ahi esta el motivo real (serie inexistente, clave mala).
    const body = await response.json().catch(() => undefined);

    if (response.status !== 200) {
      throw new UpstreamError(describeFailure(response.status, body), {
        status: response.status,
        // 429 y 5xx los reintenta el job de BullMQ; un 400 por serie mala no se arregla repitiendo.
        retryable: response.status === 429 || response.status >= 500,
      });
    }

    return body;
  }

  return {
    getObservations(seriesId, observationStart, realtimeStart, realtimeEnd) {
      return get(FRED_OBSERVATIONS_PATH, {
        series_id: seriesId,
        observation_start: observationStart,
        realtime_start: realtimeStart,
        realtime_end: realtimeEnd,
        sort_order: 'asc',
      });
    },

    getVintageDates(seriesId, from) {
      return get(FRED_VINTAGE_DATES_PATH, {
        series_id: seriesId,
        realtime_start: from,
        realtime_end: FRED_REALTIME_END,
        limit: String(FRED_VINTAGE_DATES_LIMIT),
        sort_order: 'asc',
      });
    },

    getReleaseDates(from) {
      return get(FRED_RELEASE_DATES_PATH, {
        realtime_start: from,
        realtime_end: FRED_REALTIME_END,
        // Sin esto el calendario se queda sin las fechas futuras, que son las que interesan.
        include_release_dates_with_no_data: 'true',
        limit: String(FRED_RELEASE_DATES_LIMIT),
        sort_order: 'asc',
      });
    },
  };
}
