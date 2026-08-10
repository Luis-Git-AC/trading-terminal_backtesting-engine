import { z } from 'zod';
import type { Candle, Timeframe } from '@tt/shared';
import { createRateLimiter, sleep, type RateLimiter } from '../../rate-limiter.js';
import { UpstreamError } from '../errors.js';
import { normalizeCandles, type DiscardedRow } from './normalize.js';
import {
  BITGET_DEFAULT_BASE_URL,
  BITGET_HISTORY_CANDLES_PATH,
  BITGET_MAX_PAGE_LIMIT,
  BITGET_OK_CODE,
  BITGET_PRODUCT_TYPE,
  bitgetEnvelopeSchema,
  toGranularity,
  type BitgetEnvelope,
} from './types.js';

const DEFAULT_RPS = 5;
const DEFAULT_MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 20_000;
const RETRY_AFTER_MAX_MS = 300_000;

export interface HttpHeaders {
  get(name: string): string | null;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: HttpHeaders;
  json(): Promise<unknown>;
}

export type FetchLike = (url: string) => Promise<HttpResponse>;

export type IngestEvent =
  | { kind: 'retry'; attempt: number; delayMs: number; reason: string }
  | { kind: 'discarded'; symbol: string; timeframe: Timeframe; rows: readonly DiscardedRow[] };

export type IngestLogger = (event: IngestEvent) => void;

export interface BitgetRestClientOptions {
  baseUrl?: string;
  productType?: string;
  pageLimit?: number;
  rps?: number;
  maxAttempts?: number;
  fetch?: FetchLike;
  random?: () => number;
  log?: IngestLogger;
}

export interface HistoryCandlesQuery {
  symbol: string;
  timeframe: Timeframe;
  startTime?: number | undefined;
  endTime?: number | undefined;
  limit?: number | undefined;
}

export interface BitgetRestClient {
  readonly limiter: RateLimiter;
  getHistoryCandles(query: HistoryCandlesQuery): Promise<Candle[]>;
}

const rowsSchema = z.array(z.unknown());

function assertPageLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > BITGET_MAX_PAGE_LIMIT) {
    throw new RangeError(
      `limit debe ser un entero entre 1 y ${BITGET_MAX_PAGE_LIMIT} (maximo real de Bitget), recibido: ${limit}`,
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

export function createBitgetRestClient(options: BitgetRestClientOptions = {}): BitgetRestClient {
  const baseUrl = options.baseUrl ?? BITGET_DEFAULT_BASE_URL;
  const productType = options.productType ?? BITGET_PRODUCT_TYPE;
  const pageLimit = assertPageLimit(options.pageLimit ?? BITGET_MAX_PAGE_LIMIT);
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const doFetch = options.fetch ?? ((url: string) => globalThis.fetch(url));
  const random = options.random ?? Math.random;
  const log = options.log ?? ((): void => undefined);
  const limiter = createRateLimiter({ rps: options.rps ?? DEFAULT_RPS });

  function buildUrl(query: HistoryCandlesQuery): string {
    const url = new URL(BITGET_HISTORY_CANDLES_PATH, baseUrl);
    url.searchParams.set('symbol', query.symbol);
    url.searchParams.set('productType', productType);
    url.searchParams.set('granularity', toGranularity(query.timeframe));
    url.searchParams.set('limit', String(assertPageLimit(query.limit ?? pageLimit)));
    if (query.startTime !== undefined) url.searchParams.set('startTime', String(query.startTime));
    if (query.endTime !== undefined) url.searchParams.set('endTime', String(query.endTime));
    return url.toString();
  }

  function readEnvelope(payload: unknown, attempts: number): BitgetEnvelope {
    const envelope = bitgetEnvelopeSchema.safeParse(payload);
    if (!envelope.success) {
      throw new UpstreamError(
        'Bitget devolvio un cuerpo que no tiene la forma {code, msg, data}. El contrato ha cambiado: revisa docs/phases/phase-1.md §F1-T6 antes de seguir.',
        { attempts, cause: envelope.error },
      );
    }

    if (envelope.data.code !== BITGET_OK_CODE) {
      throw new UpstreamError(
        `Bitget rechazo la peticion: ${envelope.data.code} ${envelope.data.msg}`,
        { attempts, exchangeCode: envelope.data.code },
      );
    }

    return envelope.data;
  }

  async function request(url: string): Promise<BitgetEnvelope> {
    let lastReason = 'sin intentos';
    let lastStatus: number | undefined;
    let lastCause: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      await limiter.acquire();

      let retryAfterMs: number | undefined;

      try {
        const response = await doFetch(url);

        if (response.status < 400) {
          return readEnvelope(await response.json(), attempt);
        }

        if (response.status !== 429 && response.status < 500) {
          throw new UpstreamError(`Bitget respondio HTTP ${response.status} y no se reintenta`, {
            attempts: attempt,
            status: response.status,
          });
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
      `Bitget no respondio correctamente tras ${maxAttempts} intento(s). Ultimo fallo: ${lastReason}`,
      { attempts: maxAttempts, status: lastStatus, retryable: true, cause: lastCause },
    );
  }

  return {
    limiter,

    async getHistoryCandles(query: HistoryCandlesQuery): Promise<Candle[]> {
      const envelope = await request(buildUrl(query));
      const rows = rowsSchema.safeParse(envelope.data);

      if (!rows.success) {
        throw new UpstreamError(
          'Bitget devolvio un data que no es un array de velas. El contrato ha cambiado: revisa docs/phases/phase-1.md §F1-T6 antes de seguir.',
          { cause: rows.error },
        );
      }

      const { candles, discarded } = normalizeCandles(rows.data, query.timeframe);
      if (discarded.length > 0) {
        log({
          kind: 'discarded',
          symbol: query.symbol,
          timeframe: query.timeframe,
          rows: discarded,
        });
      }

      return candles;
    },
  };
}
