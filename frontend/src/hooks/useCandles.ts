import { skipToken, useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { CandlesResponse } from '@tt/shared';
import { STALE_TIME } from '@/api/query-client';
import { queryKeys } from '@/api/query-keys';
import { getCandles, type CandlesRequest } from '@/api/resources';

export function useCandles(request: CandlesRequest | undefined): UseQueryResult<CandlesResponse> {
  return useQuery({
    queryKey: queryKeys.candles(request),
    queryFn:
      request === undefined ? skipToken : ({ signal }) => getCandles(request, undefined, signal),
    staleTime: STALE_TIME.candles,
  });
}
