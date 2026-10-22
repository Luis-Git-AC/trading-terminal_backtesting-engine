import { z } from 'zod';
import { timeframeToMs, type IngestCandle } from '@tt/shared';
import { createRateLimiter, sleep } from '../../rate-limiter.js';
import type {
  ExchangeRestClient,
  ExchangeRestClientOptions,
  HistoryCandlesQuery,
  HttpRequestInit,
} from '../adapter.js';
import { UpstreamError } from '../errors.js';
import { normalizeCandles } from './normalize.js';
import {
  HYPERLIQUID_DEFAULT_BASE_URL,
  HYPERLIQUID_INFO_PATH,
  HYPERLIQUID_MAX_HISTORY_CANDLES,
  candleSnapshotBody,
} from './types.js';

const DEFAULT_RPS = 5;
const DEFAULT_MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 20_000;
const RETRY_AFTER_MAX_MS = 300_000;

export type {
  ExchangeRestClient as HyperliquidRestClient,
  FetchLike,
  HistoryCandlesQuery,
  HttpHeaders,
  HttpResponse,
  IngestEvent,
  IngestLogger,
} from '../adapter.js';

const rowsSchema = z.array(z.unknown());

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
 * Los tramos en los que se parte una peticion, de mas reciente a mas antiguo: Hyperliquid solo
 * devuelve 5000 velas por llamada, asi que un rango mayor se pide en varias.
 */
export function splitRange(
  startTime: number,
  endTime: number,
  stepMs: number,
  maxCandles = HYPERLIQUID_MAX_HISTORY_CANDLES,
): { startTime: number; endTime: number }[] {
  const chunks: { startTime: number; endTime: number }[] = [];
  const span = maxCandles * stepMs;

  for (let end = endTime; end > startTime; end -= span) {
    chunks.push({ startTime: Math.max(startTime, end - span), endTime: end });
  }

  return chunks;
}

export function createHyperliquidRestClient(
  options: ExchangeRestClientOptions = {},
): ExchangeRestClient {
  const baseUrl = options.baseUrl ?? HYPERLIQUID_DEFAULT_BASE_URL;
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const doFetch =
    options.fetch ?? ((url: string, init?: HttpRequestInit) => globalThis.fetch(url, init));
  const random = options.random ?? Math.random;
  const log = options.log ?? ((): void => undefined);
  const limiter = createRateLimiter({ rps: options.rps ?? DEFAULT_RPS });
  const url = new URL(HYPERLIQUID_INFO_PATH, baseUrl).toString();

  async function request(body: string): Promise<unknown> {
    let lastReason = 'sin intentos';
    let lastStatus: number | undefined;
    let lastCause: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      await limiter.acquire();

      let retryAfterMs: number | undefined;

      try {
        const response = await doFetch(url, {
          method: 'POST',
          body,
          headers: { 'content-type': 'application/json' },
        });

        if (response.status < 400) {
          return await response.json();
        }

        if (response.status !== 429 && response.status < 500) {
          // Un interval o un cuerpo invalidos salen con 422 y texto plano, no JSON.
          throw new UpstreamError(
            `Hyperliquid respondio HTTP ${response.status} y no se reintenta`,
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
      `Hyperliquid no respondio correctamente tras ${maxAttempts} intento(s). Ultimo fallo: ${lastReason}`,
      { attempts: maxAttempts, status: lastStatus, retryable: true, cause: lastCause },
    );
  }

  return {
    limiter,

    async getHistoryCandles(query: HistoryCandlesQuery): Promise<IngestCandle[]> {
      const step = timeframeToMs(query.timeframe);
      const limit = Math.min(query.limit ?? HYPERLIQUID_MAX_HISTORY_CANDLES, HYPERLIQUID_MAX_HISTORY_CANDLES);
      const endTime = query.endTime ?? Date.now();
      const startTime = query.startTime ?? endTime - limit * step;

      const chunks = splitRange(startTime, endTime, step);
      const candles: IngestCandle[] = [];

      for (const chunk of chunks) {
        const payload = await request(candleSnapshotBody(query.symbol, query.timeframe, chunk.startTime, chunk.endTime));

        // Un coin que no existe devuelve null, no un array vacio.
        if (payload === null) {
          throw new UpstreamError(
            `Hyperliquid no conoce el coin ${query.symbol}: devolvio null en vez de una lista de velas`,
          );
        }

        const rows = rowsSchema.safeParse(payload);
        if (!rows.success) {
          throw new UpstreamError(
            'Hyperliquid devolvio un cuerpo que no es una lista de velas. El contrato ha cambiado: revisa docs/phases/phase-7.md §F7c-T1 antes de seguir.',
            { cause: rows.error },
          );
        }

        const normalized = normalizeCandles(rows.data, query.timeframe);
        if (normalized.discarded.length > 0) {
          log({
            kind: 'discarded',
            symbol: query.symbol,
            timeframe: query.timeframe,
            rows: normalized.discarded,
          });
        }

        candles.push(...normalized.candles);

        // Hyperliquid guarda 5000 velas por serie: si un tramo viene vacio, lo anterior no existe.
        if (normalized.candles.length === 0) {
          log({
            kind: 'truncated',
            symbol: query.symbol,
            timeframe: query.timeframe,
            detail:
              `el tramo ${new Date(chunk.startTime).toISOString()} -> ${new Date(chunk.endTime).toISOString()} ` +
              `vino vacio: Hyperliquid solo guarda ${HYPERLIQUID_MAX_HISTORY_CANDLES} velas por serie, ` +
              'ese historico no existe',
          });
          break;
        }
      }

      candles.sort((a, b) => a.t - b.t);
      return candles.slice(-limit);
    },
  };
}
