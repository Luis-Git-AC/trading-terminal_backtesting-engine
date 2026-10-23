import type { Pool } from 'pg';
import { z } from 'zod';
import {
  createMacroRepository,
  type MacroPoint,
  type MacroRepository,
} from '../../db/repositories/macro.repo.js';
import type { FetchLike } from '../../ingest/exchange/adapter.js';
import { UpstreamError } from '../../ingest/exchange/errors.js';
import type {
  NormalizedBatch,
  PersistResult,
  SourceAdapter,
  SourceContext,
  SourceItem,
} from '../adapter.js';

export const COINGECKO_SOURCE_ID = 'coingecko';
export const GLOBAL_PATH = '/api/v3/global';

export const MARKET_CAP_SERIES_ID = 'crypto-total-market-cap-usd';
export const DOMINANCE_SERIES_PREFIX = 'dominance-';

/** Las dominancias que se guardan; el resto del reparto no aporta. */
export const DOMINANCE_COINS = ['btc', 'eth'] as const;

export const globalSchema = z.object({
  data: z.object({
    total_market_cap: z.object({ usd: z.number() }),
    market_cap_percentage: z.record(z.string(), z.number()),
    /** Segundos. Es el unico `published_at` real de las cinco fuentes. */
    updated_at: z.number(),
  }),
});

/** El 429 del tier gratuito llega con este cuerpo. */
export const coingeckoErrorSchema = z.object({
  status: z.object({ error_code: z.number(), error_message: z.string() }),
});

export interface CoingeckoClientOptions {
  baseUrl: string;
  fetch: FetchLike;
  /** Se avisa de cada 429 para que quede constancia; el reintento lo hace la cola. */
  onRateLimited?: ((detail: string) => void) | undefined;
}

export interface CoingeckoClient {
  getGlobal(): Promise<unknown>;
}

export function createCoingeckoClient(options: CoingeckoClientOptions): CoingeckoClient {
  return {
    async getGlobal(): Promise<unknown> {
      const response = await options.fetch(new URL(GLOBAL_PATH, options.baseUrl).toString());
      const body = await response.json().catch(() => undefined);

      if (response.status === 429) {
        const parsed = coingeckoErrorSchema.safeParse(body);
        const detail = parsed.success
          ? parsed.data.status.error_message
          : 'sin cuerpo que lo explique';
        options.onRateLimited?.(detail);
        // Retryable: el tier gratuito tiene un limite bajo y un 429 no es un fallo del sistema,
        // asi que la cola lo reprograma con su backoff en vez de tumbar nada.
        throw new UpstreamError(`CoinGecko respondio 429: ${detail}`, {
          status: 429,
          retryable: true,
        });
      }

      if (response.status !== 200) {
        throw new UpstreamError(`CoinGecko respondio ${response.status}`, {
          status: response.status,
          retryable: response.status >= 500,
        });
      }

      return body;
    },
  };
}

export interface CoingeckoSourceOptions {
  pool: Pool;
  client: CoingeckoClient;
  schedule: string;
  /** Tier gratuito: mas conservador que el resto de fuentes. */
  rps?: number | undefined;
  macroRepo?: MacroRepository | undefined;
}

export interface CoingeckoRaw {
  fetchedAt: number;
  body: unknown;
}

interface SnapshotItem extends SourceItem {
  seriesId: string;
  t: number;
  value: number;
}

export function createCoingeckoSource(
  options: CoingeckoSourceOptions,
): SourceAdapter<CoingeckoRaw, SnapshotItem> {
  const macroRepo = options.macroRepo ?? createMacroRepository(options.pool);

  return {
    id: COINGECKO_SOURCE_ID,
    schedule: options.schedule,
    requiredEnv: [],
    rps: options.rps,

    async fetch(_since: Date | null, context: SourceContext): Promise<CoingeckoRaw> {
      const fetchedAt = context.now();
      await context.limiter.acquire();
      return { fetchedAt, body: await options.client.getGlobal() };
    },

    normalize(raw: CoingeckoRaw): NormalizedBatch<SnapshotItem> {
      const { data } = globalSchema.parse(raw.body);
      // `updated_at` es de verdad cuando CoinGecko calculo la foto, asi que es a la vez el
      // timestamp de la observacion y su `published_at`.
      const t = data.updated_at * 1000;
      const items: SnapshotItem[] = [
        {
          seriesId: MARKET_CAP_SERIES_ID,
          t,
          value: data.total_market_cap.usd,
          publishedAt: t,
          fetchedAt: raw.fetchedAt,
        },
      ];
      let discarded = 0;

      for (const coin of DOMINANCE_COINS) {
        const percentage = data.market_cap_percentage[coin];
        if (percentage === undefined) {
          discarded += 1;
          continue;
        }
        items.push({
          seriesId: `${DOMINANCE_SERIES_PREFIX}${coin}`,
          t,
          value: percentage,
          publishedAt: t,
          fetchedAt: raw.fetchedAt,
        });
      }

      return { sourceId: COINGECKO_SOURCE_ID, items, discarded };
    },

    async persist(batch: NormalizedBatch<SnapshotItem>): Promise<PersistResult> {
      let written = 0;

      for (const item of batch.items) {
        // Revision 0: cada foto trae su propio `updated_at`, asi que dos pasadas distintas no
        // compiten por la misma fila; repetir la misma foto choca con la PK y no escribe.
        const point: MacroPoint = {
          t: item.t,
          value: item.value,
          publishedAt: item.publishedAt,
          fetchedAt: item.fetchedAt,
          revision: 0,
        };
        written += await macroRepo.upsertPoints({
          source: COINGECKO_SOURCE_ID,
          seriesId: item.seriesId,
          points: [point],
        });
      }

      return { written, skipped: batch.items.length - written };
    },
  };
}
