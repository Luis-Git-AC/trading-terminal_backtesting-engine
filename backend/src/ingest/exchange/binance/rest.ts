import { z } from 'zod';
import type { IngestCandle } from '@tt/shared';
import { createRateLimiter, sleep } from '../../rate-limiter.js';
import type {
  ExchangeRestClient,
  ExchangeRestClientOptions,
  HistoryCandlesQuery,
  HttpHeaders,
} from '../adapter.js';
import { UpstreamError } from '../errors.js';
import { normalizeCandles } from './normalize.js';
import {
  BINANCE_DEFAULT_BASE_URL,
  BINANCE_KLINES_PATH,
  BINANCE_MAX_PAGE_LIMIT,
  BINANCE_WEIGHT_PER_MINUTE,
  binanceErrorSchema,
  toInterval,
} from './types.js';

const DEFAULT_RPS = 8;
const DEFAULT_MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 20_000;
const RETRY_AFTER_MAX_MS = 300_000;
const WEIGHT_WINDOW_MS = 60_000;

/** A partir de este porcentaje del peso por minuto se frena hasta la ventana siguiente. */
export const WEIGHT_PAUSE_RATIO = 0.8;

export type {
  ExchangeRestClient as BinanceRestClient,
  FetchLike,
  HistoryCandlesQuery,
  HttpHeaders,
  HttpResponse,
  IngestEvent,
  IngestLogger,
} from '../adapter.js';

const rowsSchema = z.array(z.unknown());

function assertPageLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > BINANCE_MAX_PAGE_LIMIT) {
    throw new RangeError(
      `limit debe ser un entero entre 1 y ${BINANCE_MAX_PAGE_LIMIT} (maximo real de Binance), recibido: ${limit}`,
    );
  }
  return limit;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseRetryAfter(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const seconds = Number(raw.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  const ms = seconds * 1000;
  return ms > RETRY_AFTER_MAX_MS ? undefined : ms;
}

function backoffMs(attempt: number, random: () => number): number {
  const ceiling = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt - 1));
  return Math.round(random() * ceiling);
}

/**
 * Lo que queda de la ventana de peso cuando `x-mbx-used-weight-1m` ya roza el tope.
 * Las ventanas de Binance van pegadas al minuto de reloj, asi que basta con el resto.
 */
export function weightPauseMs(headers: HttpHeaders, now: number): number {
  const raw = headers.get('x-mbx-used-weight-1m');
  if (raw === null) return 0;

  const used = Number(raw.trim());
  if (!Number.isFinite(used) || used < BINANCE_WEIGHT_PER_MINUTE * WEIGHT_PAUSE_RATIO) return 0;

  return WEIGHT_WINDOW_MS - (now % WEIGHT_WINDOW_MS);
}

function readError(payload: unknown): string | null {
  const parsed = binanceErrorSchema.safeParse(payload);
  return parsed.success ? `${parsed.data.code} ${parsed.data.msg}` : null;
}

export function createBinanceRestClient(
  options: ExchangeRestClientOptions = {},
): ExchangeRestClient {
  const baseUrl = options.baseUrl ?? BINANCE_DEFAULT_BASE_URL;
  const pageLimit = assertPageLimit(options.pageLimit ?? BINANCE_MAX_PAGE_LIMIT);
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const doFetch = options.fetch ?? ((url: string) => globalThis.fetch(url));
  const random = options.random ?? Math.random;
  const log = options.log ?? ((): void => undefined);
  const limiter = createRateLimiter({ rps: options.rps ?? DEFAULT_RPS });

  function buildUrl(query: HistoryCandlesQuery): string {
    const url = new URL(BINANCE_KLINES_PATH, baseUrl);
    url.searchParams.set('symbol', query.symbol);
    url.searchParams.set('interval', toInterval(query.timeframe));
    url.searchParams.set('limit', String(assertPageLimit(query.limit ?? pageLimit)));
    if (query.startTime !== undefined) url.searchParams.set('startTime', String(query.startTime));
    if (query.endTime !== undefined) url.searchParams.set('endTime', String(query.endTime));
    return url.toString();
  }

  async function request(url: string): Promise<unknown> {
    let lastReason = 'sin intentos';
    let lastStatus: number | undefined;
    let lastCause: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      await limiter.acquire();

      let retryAfterMs: number | undefined;

      try {
        const response = await doFetch(url);
        limiter.pause(weightPauseMs(response.headers, Date.now()));

        if (response.status < 400) {
          return await response.json();
        }

        // 418: Binance ya ha baneado la IP por insistir tras un 429. Reintentar lo alarga.
        if (response.status === 418) {
          throw new UpstreamError(
            'Binance respondio HTTP 418: la IP esta baneada por exceso de peticiones. No se reintenta.',
            { attempts: attempt, status: 418 },
          );
        }

        if (response.status !== 429 && response.status < 500) {
          const detail = readError(await response.json().catch(() => null));
          throw new UpstreamError(
            `Binance respondio HTTP ${response.status} y no se reintenta${detail === null ? '' : `: ${detail}`}`,
            { attempts: attempt, status: response.status },
          );
        }

        lastStatus = response.status;
        lastReason = `HTTP ${response.status}`;
        if (response.status === 429) {
          retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
        }
      } catch (error) {
        if (error instanceof UpstreamError) throw error;
        lastReason = `error de red: ${describe(error)}`;
        lastCause = error;
      }

      if (attempt === maxAttempts) break;

      const delayMs = retryAfterMs ?? backoffMs(attempt, random);
      log({ kind: 'retry', attempt, delayMs, reason: lastReason });
      await sleep(delayMs);
    }

    throw new UpstreamError(
      `Binance no respondio correctamente tras ${maxAttempts} intento(s). Ultimo fallo: ${lastReason}`,
      { attempts: maxAttempts, status: lastStatus, retryable: true, cause: lastCause },
    );
  }

  return {
    limiter,

    async getHistoryCandles(query: HistoryCandlesQuery): Promise<IngestCandle[]> {
      const payload = await request(buildUrl(query));
      const rows = rowsSchema.safeParse(payload);

      if (!rows.success) {
        const detail = readError(payload);
        throw new UpstreamError(
          detail === null
            ? 'Binance devolvio un cuerpo que no es un array de klines. El contrato ha cambiado: revisa docs/phases/phase-7.md §F7b-T1 antes de seguir.'
            : `Binance rechazo la peticion: ${detail}`,
          detail === null ? { cause: rows.error } : {},
        );
      }

      const { candles, discarded } = normalizeCandles(rows.data, query.timeframe);
      if (discarded.length > 0) {
        log({ kind: 'discarded', symbol: query.symbol, timeframe: query.timeframe, rows: discarded });
      }

      return candles;
    },
  };
}
