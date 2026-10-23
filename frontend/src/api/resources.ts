import {
  cancelBacktestResponseSchema,
  candlesResponseSchema,
  compareResponseSchema,
  coverageResponseSchema,
  createBacktestResponseSchema,
  equityResponseSchema,
  eventsResponseSchema,
  fundingResponseSchema,
  healthResponseSchema,
  listBacktestsResponseSchema,
  macroSeriesResponseSchema,
  marketsResponseSchema,
  openInterestResponseSchema,
  runDetailSchema,
  strategyCatalogSchema,
  tradesResponseSchema,
  type CancelBacktestResponse,
  type CandlesResponse,
  type CompareResponse,
  type CoverageResponse,
  type CreateBacktestBody,
  type CreateBacktestResponse,
  type EquityResponse,
  type EventsResponse,
  type Exchange,
  type FundingResponse,
  type HealthResponse,
  type ListBacktestsQuery,
  type ListBacktestsResponse,
  type MacroSeriesResponse,
  type MarketsResponse,
  type OpenInterestResponse,
  type RunDetail,
  type RunStatus,
  type StrategyCatalog,
  type Timeframe,
  type TradesQuery,
  type TradesResponse,
} from '@tt/shared';
import { apiClient, type ApiClient } from '@/api/client';

export interface CandlesRequest {
  readonly exchange: Exchange;
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly from: number;
  readonly to?: number | undefined;
  readonly limit?: number | undefined;
}

export interface DerivativesRequest {
  readonly exchange: Exchange;
  readonly symbol: string;
  readonly from: number;
  readonly to?: number | undefined;
  readonly limit?: number | undefined;
}

export interface MacroRequest {
  readonly seriesId: string;
  readonly from: number;
  readonly to?: number | undefined;
  /** Corte point-in-time: lo que se sabia en ese instante. */
  readonly asOf?: number | undefined;
  /** Solo hace falta si dos fuentes publican la serie con el mismo id. */
  readonly source?: string | undefined;
  readonly limit?: number | undefined;
}

export interface EventsRequest {
  readonly from: number;
  readonly to?: number | undefined;
  readonly asOf?: number | undefined;
  readonly asset?: readonly string[] | undefined;
  readonly limit?: number | undefined;
}

export interface RunsRequest {
  readonly status?: RunStatus | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

export interface TradesRequest {
  readonly runId: string;
  readonly limit?: number | undefined;
  readonly cursor?: number | undefined;
}

export function getHealth(
  client: ApiClient = apiClient,
  signal?: AbortSignal,
): Promise<HealthResponse> {
  return client.request({ path: '/health', schema: healthResponseSchema, signal });
}

export function getMarkets(
  client: ApiClient = apiClient,
  signal?: AbortSignal,
): Promise<MarketsResponse> {
  return client.request({ path: '/markets', schema: marketsResponseSchema, signal });
}

export function getCoverage(
  exchange: Exchange,
  symbol: string,
  timeframe: Timeframe,
  client: ApiClient = apiClient,
  signal?: AbortSignal,
): Promise<CoverageResponse> {
  return client.request({
    path: `/markets/${encodeURIComponent(exchange)}/${encodeURIComponent(symbol)}/coverage`,
    query: { timeframe },
    schema: coverageResponseSchema,
    signal,
  });
}

export function getCandles(
  request: CandlesRequest,
  client: ApiClient = apiClient,
  signal?: AbortSignal,
): Promise<CandlesResponse> {
  return client.request({
    path: '/candles',
    query: {
      exchange: request.exchange,
      symbol: request.symbol,
      timeframe: request.timeframe,
      from: request.from,
      to: request.to,
      limit: request.limit,
    },
    schema: candlesResponseSchema,
    signal,
  });
}

function derivativesPath(request: DerivativesRequest, resource: string): string {
  const { exchange, symbol } = request;
  return `/derivatives/${encodeURIComponent(exchange)}/${encodeURIComponent(symbol)}/${resource}`;
}

export function getFunding(
  request: DerivativesRequest,
  client: ApiClient = apiClient,
  signal?: AbortSignal,
): Promise<FundingResponse> {
  return client.request({
    path: derivativesPath(request, 'funding'),
    query: { from: request.from, to: request.to, limit: request.limit },
    schema: fundingResponseSchema,
    signal,
  });
}

export function getMacroSeries(
  request: MacroRequest,
  client: ApiClient = apiClient,
  signal?: AbortSignal,
): Promise<MacroSeriesResponse> {
  return client.request({
    path: `/macro/series/${encodeURIComponent(request.seriesId)}`,
    query: {
      from: request.from,
      to: request.to,
      asOf: request.asOf,
      source: request.source,
      limit: request.limit,
    },
    schema: macroSeriesResponseSchema,
    signal,
  });
}

export function getMarketEvents(
  request: EventsRequest,
  client: ApiClient = apiClient,
  signal?: AbortSignal,
): Promise<EventsResponse> {
  return client.request({
    path: '/events',
    query: {
      from: request.from,
      to: request.to,
      asOf: request.asOf,
      asset: request.asset === undefined ? undefined : request.asset.join(','),
      limit: request.limit,
    },
    schema: eventsResponseSchema,
    signal,
  });
}

export function getOpenInterest(
  request: DerivativesRequest,
  client: ApiClient = apiClient,
  signal?: AbortSignal,
): Promise<OpenInterestResponse> {
  return client.request({
    path: derivativesPath(request, 'open-interest'),
    query: { from: request.from, to: request.to, limit: request.limit },
    schema: openInterestResponseSchema,
    signal,
  });
}

export function getStrategies(
  client: ApiClient = apiClient,
  signal?: AbortSignal,
): Promise<StrategyCatalog> {
  return client.request({ path: '/strategies', schema: strategyCatalogSchema, signal });
}

export function listRuns(
  request: RunsRequest = {},
  client: ApiClient = apiClient,
  signal?: AbortSignal,
): Promise<ListBacktestsResponse> {
  return client.request({
    path: '/backtests',
    query: { status: request.status, limit: request.limit, offset: request.offset },
    schema: listBacktestsResponseSchema,
    signal,
  });
}

export function getRun(
  runId: string,
  client: ApiClient = apiClient,
  signal?: AbortSignal,
): Promise<RunDetail> {
  return client.request({
    path: `/backtests/${encodeURIComponent(runId)}`,
    schema: runDetailSchema,
    signal,
  });
}

export function getRunTrades(
  request: TradesRequest,
  client: ApiClient = apiClient,
  signal?: AbortSignal,
): Promise<TradesResponse> {
  return client.request({
    path: `/backtests/${encodeURIComponent(request.runId)}/trades`,
    query: { limit: request.limit, cursor: request.cursor },
    schema: tradesResponseSchema,
    signal,
  });
}

export function getRunEquity(
  runId: string,
  client: ApiClient = apiClient,
  signal?: AbortSignal,
): Promise<EquityResponse> {
  return client.request({
    path: `/backtests/${encodeURIComponent(runId)}/equity`,
    schema: equityResponseSchema,
    signal,
  });
}

export function compareRuns(
  ids: readonly string[],
  client: ApiClient = apiClient,
  signal?: AbortSignal,
): Promise<CompareResponse> {
  return client.request({
    path: '/backtests/compare',
    query: { ids: ids.join(',') },
    schema: compareResponseSchema,
    signal,
  });
}

export function createBacktest(
  body: CreateBacktestBody,
  client: ApiClient = apiClient,
): Promise<CreateBacktestResponse> {
  return client.request({
    path: '/backtests',
    method: 'POST',
    body,
    schema: createBacktestResponseSchema,
  });
}

export function cancelBacktest(
  runId: string,
  client: ApiClient = apiClient,
): Promise<CancelBacktestResponse> {
  return client.request({
    path: `/backtests/${encodeURIComponent(runId)}/cancel`,
    method: 'POST',
    schema: cancelBacktestResponseSchema,
  });
}

export function deleteBacktest(runId: string, client: ApiClient = apiClient): Promise<void> {
  return client.requestVoid({
    path: `/backtests/${encodeURIComponent(runId)}`,
    method: 'DELETE',
  });
}

export type { ListBacktestsQuery, TradesQuery };
