import { z } from 'zod';
import type { FundingRate, OpenInterestPoint } from '@tt/shared';
import type {
  DerivativesHistoryQuery,
  ExchangeDerivativesClient,
  ExchangeRestClientOptions,
  IngestLogger,
} from '../adapter.js';
import { UpstreamError } from '../errors.js';
import { createHyperliquidRequester } from './rest.js';
import {
  HYPERLIQUID_FUNDING_INTERVAL_HOURS,
  dexOf,
  fundingHistoryBody,
  hyperliquidAssetCtxSchema,
  hyperliquidFundingRowSchema,
  metaAndAssetCtxsBody,
} from './types.js';

/** Sin `startTime` el endpoint no responde nada util, asi que hay un suelo por defecto. */
export const DEFAULT_FUNDING_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

const fundingListSchema = z.array(hyperliquidFundingRowSchema);
const metaAndAssetCtxsSchema = z.tuple([
  z.object({ universe: z.array(z.object({ name: z.string() })) }),
  z.array(hyperliquidAssetCtxSchema),
]);

export function createHyperliquidDerivativesClient(
  options: ExchangeRestClientOptions = {},
): ExchangeDerivativesClient {
  const log: IngestLogger = options.log ?? ((): void => undefined);
  const { request } = createHyperliquidRequester(options);
  const now = (): number => Date.now();

  return {
    async getFundingHistory(query: DerivativesHistoryQuery): Promise<FundingRate[]> {
      const startTime = query.startTime ?? now() - DEFAULT_FUNDING_LOOKBACK_MS;
      const payload = await request(fundingHistoryBody(query.symbol, startTime, query.endTime));

      // Un coin que no existe devuelve null, igual que en candleSnapshot.
      if (payload === null) {
        throw new UpstreamError(
          `Hyperliquid no conoce el coin ${query.symbol}: devolvio null en vez de una lista de funding`,
        );
      }

      const parsed = fundingListSchema.safeParse(payload);
      if (!parsed.success) {
        throw new UpstreamError(
          'Hyperliquid devolvio un cuerpo que no es una lista de funding. El contrato ha cambiado: revisa docs/phases/phase-8.md §F8-T4 antes de seguir.',
          { cause: parsed.error },
        );
      }

      return parsed.data
        .filter((row) => Number.isFinite(Number(row.fundingRate)))
        .map((row) => ({
          t: row.time,
          rate: Number(row.fundingRate),
          intervalHours: HYPERLIQUID_FUNDING_INTERVAL_HOURS,
        }));
    },

    getOpenInterestHistory(query: DerivativesHistoryQuery): Promise<OpenInterestPoint[]> {
      // Hyperliquid no publica OI historico: solo el valor vivo del ctx. No se simula.
      log({
        kind: 'truncated',
        symbol: query.symbol,
        timeframe: '1h',
        detail: 'Hyperliquid no tiene endpoint de open interest historico: solo el vivo de activeAssetCtx',
      });
      return Promise.resolve([]);
    },

    async getOpenInterest(symbol: string): Promise<OpenInterestPoint> {
      const payload = await request(metaAndAssetCtxsBody(dexOf(symbol)));
      const parsed = metaAndAssetCtxsSchema.safeParse(payload);
      if (!parsed.success) {
        throw new UpstreamError(
          'Hyperliquid devolvio un metaAndAssetCtxs inesperado. El contrato ha cambiado: revisa docs/phases/phase-8.md §F8-T4 antes de seguir.',
          { cause: parsed.error },
        );
      }

      const [meta, ctxs] = parsed.data;
      const index = meta.universe.findIndex((asset) => asset.name === symbol);
      const ctx = index === -1 ? undefined : ctxs[index];
      if (ctx === undefined) {
        throw new UpstreamError(`Hyperliquid no lista el coin ${symbol} en metaAndAssetCtxs`);
      }

      const base = Number(ctx.openInterest);
      if (!Number.isFinite(base)) {
        throw new UpstreamError(`Hyperliquid devolvio un open interest no numerico para ${symbol}`);
      }

      // El ctx no trae ts: el open interest es un valor vivo, se sella con el reloj.
      return { t: now(), base, quote: null };
    },
  };
}
