import type { Pool } from 'pg';
import { z } from 'zod';
import {
  createMacroRepository,
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
import { withRevisions } from '../revisions.js';

export const DEFILLAMA_SOURCE_ID = 'defillama';

export const TVL_PATH = '/v2/historicalChainTvl';
export const STABLECOINS_PATH = '/stablecoincharts/all';

export const TVL_SERIES_ID = 'tvl-total-usd';
export const STABLECOINS_SERIES_ID = 'stablecoins-circulating-usd';

/** El `date` llega como numero en TVL y como string en stablecoins; los dos en segundos. */
const unixSeconds = z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)]);

export const tvlSchema = z.array(z.object({ date: unixSeconds, tvl: z.number() }));

export const stablecoinsSchema = z.array(
  z.object({
    date: unixSeconds,
    /** Circulante valorado en dolares; `totalCirculating` es en unidades de cada moneda. */
    totalCirculatingUSD: z.object({ peggedUSD: z.number() }),
  }),
);

export interface DefillamaClientOptions {
  tvlBaseUrl: string;
  stablecoinsBaseUrl: string;
  fetch: FetchLike;
}

export interface DefillamaClient {
  getHistoricalChainTvl(): Promise<unknown>;
  getStablecoinCharts(): Promise<unknown>;
}

export function createDefillamaClient(options: DefillamaClientOptions): DefillamaClient {
  async function get(baseUrl: string, path: string): Promise<unknown> {
    const response = await options.fetch(new URL(path, baseUrl).toString());
    const body = await response.json().catch(() => undefined);

    if (response.status !== 200) {
      throw new UpstreamError(`DefiLlama respondio ${response.status}`, {
        status: response.status,
        retryable: response.status === 429 || response.status >= 500,
      });
    }

    return body;
  }

  return {
    getHistoricalChainTvl: () => get(options.tvlBaseUrl, TVL_PATH),
    getStablecoinCharts: () => get(options.stablecoinsBaseUrl, STABLECOINS_PATH),
  };
}

export interface DefillamaSourceOptions {
  pool: Pool;
  client: DefillamaClient;
  schedule: string;
  /** Desde cuando se guarda historico: la serie de TVL arranca en 2017 y casi toda es cero. */
  from: number;
  macroRepo?: MacroRepository | undefined;
}

export interface DefillamaRaw {
  fetchedAt: number;
  tvl: unknown;
  stablecoins: unknown;
}

interface SeriesItem extends SourceItem {
  seriesId: string;
  t: number;
  value: number;
}

export function createDefillamaSource(
  options: DefillamaSourceOptions,
): SourceAdapter<DefillamaRaw, SeriesItem> {
  const macroRepo = options.macroRepo ?? createMacroRepository(options.pool);

  return {
    id: DEFILLAMA_SOURCE_ID,
    schedule: options.schedule,
    requiredEnv: [],

    async fetch(_since: Date | null, context: SourceContext): Promise<DefillamaRaw> {
      const fetchedAt = context.now();

      await context.limiter.acquire();
      const tvl = await options.client.getHistoricalChainTvl();
      await context.limiter.acquire();
      const stablecoins = await options.client.getStablecoinCharts();

      return { fetchedAt, tvl, stablecoins };
    },

    normalize(raw: DefillamaRaw): NormalizedBatch<SeriesItem> {
      const items: SeriesItem[] = [];
      let discarded = 0;

      const push = (seriesId: string, seconds: number, value: number): void => {
        const t = seconds * 1000;
        if (t < options.from) {
          discarded += 1;
          return;
        }
        items.push({
          seriesId,
          t,
          value,
          // DefiLlama no dice cuando calculo el punto: es la foto de ese dia, y ese instante es lo
          // unico estable que hay. El corte point-in-time lo da `fetched_at`.
          publishedAt: t,
          fetchedAt: raw.fetchedAt,
        });
      };

      // Un cambio de forma de la API tiene que ser ruidoso: no se descarta en silencio.
      for (const point of tvlSchema.parse(raw.tvl)) push(TVL_SERIES_ID, point.date, point.tvl);
      for (const point of stablecoinsSchema.parse(raw.stablecoins)) {
        push(STABLECOINS_SERIES_ID, point.date, point.totalCirculatingUSD.peggedUSD);
      }

      return { sourceId: DEFILLAMA_SOURCE_ID, items, discarded };
    },

    async persist(batch: NormalizedBatch<SeriesItem>): Promise<PersistResult> {
      const bySeries = new Map<string, SeriesItem[]>();
      for (const item of batch.items) {
        const group = bySeries.get(item.seriesId);
        if (group === undefined) bySeries.set(item.seriesId, [item]);
        else group.push(item);
      }

      let written = 0;
      for (const [seriesId, group] of bySeries) {
        // DefiLlama recalcula TVL historico cuando corrige un protocolo, asi que un valor nuevo
        // para una fecha ya guardada es una revision, no un duplicado.
        written += await macroRepo.upsertPoints({
          source: DEFILLAMA_SOURCE_ID,
          seriesId,
          points: await withRevisions(
            macroRepo,
            { source: DEFILLAMA_SOURCE_ID, seriesId },
            group,
          ),
        });
      }

      return { written, skipped: batch.items.length - written };
    },
  };
}
