import { z } from 'zod';
import type { FundingRate, OpenInterestPoint } from '@tt/shared';
import type { ExchangeRestClientOptions, IngestLogger } from '../adapter.js';
import { UpstreamError } from '../errors.js';
import { createBinanceRequester } from './rest.js';
import {
  BINANCE_DEFAULT_BASE_URL,
  BINANCE_DEFAULT_FUNDING_INTERVAL_HOURS,
  BINANCE_FUNDING_INFO_PATH,
  BINANCE_FUNDING_MAX_LIMIT,
  BINANCE_FUNDING_PATH,
  BINANCE_OI_HIST_MAX_LIMIT,
  BINANCE_OI_HIST_PATH,
  BINANCE_OI_HIST_WINDOW_DAYS,
  BINANCE_OI_PATH,
  binanceFundingInfoRowSchema,
  binanceFundingRowSchema,
  binanceOpenInterestHistRowSchema,
  binanceOpenInterestSchema,
  type OpenInterestPeriod,
} from './types.js';

export const OI_HIST_WINDOW_MS = BINANCE_OI_HIST_WINDOW_DAYS * 24 * 60 * 60 * 1000;

const fundingListSchema = z.array(binanceFundingRowSchema);
const fundingInfoListSchema = z.array(binanceFundingInfoRowSchema);
const openInterestHistListSchema = z.array(binanceOpenInterestHistRowSchema);

export interface FundingHistoryQuery {
  symbol: string;
  startTime?: number | undefined;
  endTime?: number | undefined;
  limit?: number | undefined;
}

export interface OpenInterestHistoryQuery extends FundingHistoryQuery {
  period?: OpenInterestPeriod | undefined;
}

export interface DerivativesClient {
  fundingIntervalHours(symbol: string): Promise<number>;
  getFundingHistory(query: FundingHistoryQuery): Promise<FundingRate[]>;
  getOpenInterestHistory(query: OpenInterestHistoryQuery): Promise<OpenInterestPoint[]>;
  getOpenInterest(symbol: string): Promise<OpenInterestPoint>;
}

function clamp(limit: number | undefined, max: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return max;
  return Math.min(max, Math.max(1, Math.floor(limit)));
}

function contractChanged(what: string, error: z.ZodError): UpstreamError {
  return new UpstreamError(
    `Binance devolvio un cuerpo inesperado en ${what}. El contrato ha cambiado: revisa docs/phases/phase-8.md §F8-T3 antes de seguir.`,
    { cause: error },
  );
}

export function createBinanceDerivativesClient(
  options: ExchangeRestClientOptions = {},
): DerivativesClient {
  const baseUrl = options.baseUrl ?? BINANCE_DEFAULT_BASE_URL;
  const log: IngestLogger = options.log ?? ((): void => undefined);
  const { request } = createBinanceRequester(options);

  let intervalsBySymbol: Map<string, number> | undefined;

  function buildUrl(path: string, params: Record<string, string | number | undefined>): string {
    const url = new URL(path, baseUrl);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  async function loadFundingInfo(): Promise<Map<string, number>> {
    if (intervalsBySymbol !== undefined) return intervalsBySymbol;

    const payload = await request(buildUrl(BINANCE_FUNDING_INFO_PATH, {}));
    const parsed = fundingInfoListSchema.safeParse(payload);
    if (!parsed.success) throw contractChanged('fundingInfo', parsed.error);

    intervalsBySymbol = new Map(
      parsed.data.map((row) => [row.symbol, row.fundingIntervalHours] as const),
    );
    return intervalsBySymbol;
  }

  async function fundingIntervalHours(symbol: string): Promise<number> {
    const intervals = await loadFundingInfo();
    // Binance solo lista en fundingInfo los simbolos que se salen de las 8 h por defecto.
    return intervals.get(symbol) ?? BINANCE_DEFAULT_FUNDING_INTERVAL_HOURS;
  }

  return {
    fundingIntervalHours,

    async getFundingHistory(query: FundingHistoryQuery): Promise<FundingRate[]> {
      const intervalHours = await fundingIntervalHours(query.symbol);
      const payload = await request(
        buildUrl(BINANCE_FUNDING_PATH, {
          symbol: query.symbol,
          startTime: query.startTime,
          endTime: query.endTime,
          limit: clamp(query.limit, BINANCE_FUNDING_MAX_LIMIT),
        }),
      );

      const parsed = fundingListSchema.safeParse(payload);
      if (!parsed.success) throw contractChanged('fundingRate', parsed.error);

      return parsed.data
        .filter((row) => Number.isFinite(Number(row.fundingRate)))
        .map((row) => ({
          t: row.fundingTime,
          rate: Number(row.fundingRate),
          intervalHours,
        }));
    },

    async getOpenInterestHistory(query: OpenInterestHistoryQuery): Promise<OpenInterestPoint[]> {
      const oldest = Date.now() - OI_HIST_WINDOW_MS;
      let startTime = query.startTime;

      // Un startTime anterior a la ventana no da menos datos: da HTTP 400 -1130.
      if (startTime !== undefined && startTime < oldest) {
        log({
          kind: 'truncated',
          symbol: query.symbol,
          timeframe: '1h',
          detail: `openInterestHist solo guarda ${BINANCE_OI_HIST_WINDOW_DAYS} dias: se pide desde ${new Date(oldest).toISOString()} en vez de ${new Date(startTime).toISOString()}`,
        });
        startTime = oldest;
      }

      const payload = await request(
        buildUrl(BINANCE_OI_HIST_PATH, {
          symbol: query.symbol,
          period: query.period ?? '1h',
          startTime,
          endTime: query.endTime,
          limit: clamp(query.limit, BINANCE_OI_HIST_MAX_LIMIT),
        }),
      );

      const parsed = openInterestHistListSchema.safeParse(payload);
      if (!parsed.success) throw contractChanged('openInterestHist', parsed.error);

      return parsed.data.map((row) => ({
        t: row.timestamp,
        base: Number(row.sumOpenInterest),
        quote: Number(row.sumOpenInterestValue),
      }));
    },

    async getOpenInterest(symbol: string): Promise<OpenInterestPoint> {
      const payload = await request(buildUrl(BINANCE_OI_PATH, { symbol }));
      const parsed = binanceOpenInterestSchema.safeParse(payload);
      if (!parsed.success) throw contractChanged('openInterest', parsed.error);

      return { t: parsed.data.time, base: Number(parsed.data.openInterest), quote: null };
    },
  };
}
