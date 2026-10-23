import type { FetchLike } from '../../ingest/exchange/adapter.js';
import { UpstreamError } from '../../ingest/exchange/errors.js';
import { EIA_PAGE_LENGTH, EIA_STOCKS_PATH, eiaErrorSchema } from './types.js';

export interface EiaClientOptions {
  apiKey: string;
  baseUrl: string;
  fetch: FetchLike;
}

export interface EiaClient {
  /** Crudo, sin tocar: la validacion es de `normalize` (ADR-006, raw inmutable). */
  getWeeklyStocks(seriesIds: readonly string[], start: string): Promise<unknown>;
}

/** El cuerpo de error de la EIA si viene; si no, el status a secas. */
function describeFailure(status: number, body: unknown): string {
  const parsed = eiaErrorSchema.safeParse(body);
  if (!parsed.success) return `la EIA respondio ${status}`;
  return `la EIA respondio ${status}: ${parsed.data.error.code} ${parsed.data.error.message}`;
}

export function createEiaClient(options: EiaClientOptions): EiaClient {
  return {
    async getWeeklyStocks(seriesIds: readonly string[], start: string): Promise<unknown> {
      const url = new URL(EIA_STOCKS_PATH, options.baseUrl);
      url.searchParams.set('api_key', options.apiKey);
      url.searchParams.set('frequency', 'weekly');
      url.searchParams.set('data[0]', 'value');
      // Todas las series en una peticion: la API v2 repite la faceta y cada fila dice la suya.
      for (const seriesId of seriesIds) url.searchParams.append('facets[series][]', seriesId);
      url.searchParams.set('start', start);
      url.searchParams.set('sort[0][column]', 'period');
      url.searchParams.set('sort[0][direction]', 'asc');
      // shortcut: una sola pagina, sin `offset`; 5000 filas son ~30 anos de tres series
      // semanales. Si se anaden mas series o se baja `EIA_START`, hay que paginar.
      url.searchParams.set('length', String(EIA_PAGE_LENGTH));

      const response = await options.fetch(url.toString());
      // El cuerpo se lee tambien en el error: ahi esta el motivo real (clave mala, ruta mala).
      const body = await response.json().catch(() => undefined);

      if (response.status !== 200) {
        throw new UpstreamError(describeFailure(response.status, body), {
          status: response.status,
          // 429 y 5xx los reintenta el job de BullMQ; un 403 por clave mala no se arregla repitiendo.
          retryable: response.status === 429 || response.status >= 500,
        });
      }

      return body;
    },
  };
}
