import type { Pool } from 'pg';
import type { FundingRate, OpenInterestPoint } from '@tt/shared';
import { createDerivativesRepository } from '../db/repositories/derivatives.repo.js';
import type { ExchangeDerivativesClient } from '../ingest/exchange/adapter.js';
import type {
  NormalizedBatch,
  PersistResult,
  SourceAdapter,
  SourceContext,
  SourceItem,
} from './adapter.js';

export const DERIVATIVES_SOURCE_ID = 'derivatives';

/** Cuanto se pide hacia atras la primera vez que se recoge un mercado. */
export const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

export interface DerivativesMarket {
  readonly exchange: string;
  readonly symbol: string;
  readonly client: ExchangeDerivativesClient;
}

export interface DerivativesSourceOptions {
  readonly pool: Pool;
  readonly markets: readonly DerivativesMarket[];
  readonly schedule: string;
  readonly lookbackMs?: number | undefined;
  readonly onMarketError?: (market: DerivativesMarket, error: unknown) => void;
}

export type DerivativesItem = SourceItem &
  (
    | { readonly kind: 'funding'; readonly exchange: string; readonly symbol: string; readonly rate: FundingRate }
    | { readonly kind: 'openInterest'; readonly exchange: string; readonly symbol: string; readonly point: OpenInterestPoint }
  );

export interface DerivativesRaw {
  readonly fetchedAt: number;
  readonly markets: readonly {
    readonly exchange: string;
    readonly symbol: string;
    readonly rates: readonly FundingRate[];
    readonly points: readonly OpenInterestPoint[];
  }[];
}

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/**
 * Funding y open interest de los exchanges. Reanuda desde el ultimo `ts` guardado de cada mercado,
 * asi que repetirla no vuelve a pedir lo que ya esta; `since` solo marca el suelo de la primera vez.
 *
 * Un mercado que falla no tumba a los demas: su error se reporta y la pasada sigue.
 */
export function createDerivativesSource(
  options: DerivativesSourceOptions,
): SourceAdapter<DerivativesRaw, DerivativesItem> {
  const repo = createDerivativesRepository(options.pool);
  const lookbackMs = options.lookbackMs ?? DEFAULT_LOOKBACK_MS;
  const onMarketError = options.onMarketError ?? ((): void => undefined);

  return {
    id: DERIVATIVES_SOURCE_ID,
    schedule: options.schedule,

    async fetch(since: Date | null, context: SourceContext): Promise<DerivativesRaw> {
      const fetchedAt = context.now();
      const floor = since === null ? fetchedAt - lookbackMs : since.getTime();
      const markets: DerivativesRaw['markets'][number][] = [];

      for (const market of options.markets) {
        try {
          const ref = { exchange: market.exchange, symbol: market.symbol };

          await context.limiter.acquire();
          const lastFunding = await repo.getLastFundingTs(ref);
          const rates = await market.client.getFundingHistory({
            symbol: market.symbol,
            startTime: lastFunding === null ? floor : lastFunding + 1,
          });

          await context.limiter.acquire();
          const lastOi = await repo.getLastOpenInterestTs(ref);
          const history = await market.client.getOpenInterestHistory({
            symbol: market.symbol,
            startTime: lastOi === null ? floor : lastOi + 1,
          });
          const current = await market.client.getOpenInterest(market.symbol);

          markets.push({ ...ref, rates, points: [...history, current] });
        } catch (error) {
          onMarketError(market, error);
        }
      }

      return { fetchedAt, markets };
    },

    normalize(raw: DerivativesRaw): NormalizedBatch<DerivativesItem> {
      const items: DerivativesItem[] = [];
      let discarded = 0;

      for (const market of raw.markets) {
        for (const rate of market.rates) {
          if (!Number.isFinite(rate.t) || !Number.isFinite(rate.rate) || !isFinitePositive(rate.intervalHours)) {
            discarded += 1;
            continue;
          }
          items.push({
            kind: 'funding',
            exchange: market.exchange,
            symbol: market.symbol,
            rate,
            publishedAt: rate.t,
            fetchedAt: raw.fetchedAt,
          });
        }

        for (const point of market.points) {
          if (!Number.isFinite(point.t) || !Number.isFinite(point.base) || point.base < 0) {
            discarded += 1;
            continue;
          }
          items.push({
            kind: 'openInterest',
            exchange: market.exchange,
            symbol: market.symbol,
            point,
            publishedAt: point.t,
            fetchedAt: raw.fetchedAt,
          });
        }
      }

      return { sourceId: DERIVATIVES_SOURCE_ID, items, discarded };
    },

    async persist(batch: NormalizedBatch<DerivativesItem>): Promise<PersistResult> {
      const byMarket = new Map<string, { exchange: string; symbol: string; rates: FundingRate[]; points: OpenInterestPoint[] }>();

      for (const item of batch.items) {
        const key = `${item.exchange}/${item.symbol}`;
        const bucket = byMarket.get(key) ?? {
          exchange: item.exchange,
          symbol: item.symbol,
          rates: [],
          points: [],
        };
        if (item.kind === 'funding') bucket.rates.push(item.rate);
        else bucket.points.push(item.point);
        byMarket.set(key, bucket);
      }

      let written = 0;

      for (const bucket of byMarket.values()) {
        const ref = { exchange: bucket.exchange, symbol: bucket.symbol, source: 'rest' as const };
        if (bucket.rates.length > 0) {
          written += await repo.upsertFundingRates({ ...ref, rates: bucket.rates });
        }
        if (bucket.points.length > 0) {
          written += await repo.upsertOpenInterest({ ...ref, points: bucket.points });
        }
      }

      return { written, skipped: batch.items.length - written };
    },
  };
}
