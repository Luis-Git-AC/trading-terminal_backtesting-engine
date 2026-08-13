import { skipToken, useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { CoverageResponse, MarketsResponse, Timeframe } from '@tt/shared';
import { STALE_TIME } from '@/api/query-client';
import { queryKeys } from '@/api/query-keys';
import { getCoverage, getMarkets } from '@/api/resources';

export function useMarkets(): UseQueryResult<MarketsResponse> {
  return useQuery({
    queryKey: queryKeys.markets(),
    queryFn: ({ signal }) => getMarkets(undefined, signal),
    staleTime: STALE_TIME.markets,
  });
}

export function useCoverage(
  symbol: string | undefined,
  timeframe: Timeframe | undefined,
): UseQueryResult<CoverageResponse> {
  return useQuery({
    queryKey: queryKeys.coverage(symbol, timeframe),
    queryFn:
      symbol === undefined || timeframe === undefined
        ? skipToken
        : ({ signal }) => getCoverage(symbol, timeframe, undefined, signal),
    staleTime: STALE_TIME.coverage,
  });
}
