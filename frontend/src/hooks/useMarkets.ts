import { skipToken, useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { CoverageResponse, Exchange, MarketsResponse, Timeframe } from '@tt/shared';
import type { ApiError } from '@/api/errors';
import { STALE_TIME } from '@/api/query-client';
import { queryKeys } from '@/api/query-keys';
import { getCoverage, getMarkets } from '@/api/resources';

export function useMarkets(): UseQueryResult<MarketsResponse, ApiError> {
  return useQuery({
    queryKey: queryKeys.markets(),
    queryFn: ({ signal }) => getMarkets(undefined, signal),
    staleTime: STALE_TIME.markets,
  });
}

export function useCoverage(
  exchange: Exchange | undefined,
  symbol: string | undefined,
  timeframe: Timeframe | undefined,
): UseQueryResult<CoverageResponse, ApiError> {
  return useQuery({
    queryKey: queryKeys.coverage(exchange, symbol, timeframe),
    queryFn:
      exchange === undefined || symbol === undefined || timeframe === undefined
        ? skipToken
        : ({ signal }) => getCoverage(exchange, symbol, timeframe, undefined, signal),
    staleTime: STALE_TIME.coverage,
  });
}
