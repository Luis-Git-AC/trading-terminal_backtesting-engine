import { skipToken, useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { FundingResponse, OpenInterestResponse } from '@tt/shared';
import type { ApiError } from '@/api/errors';
import { STALE_TIME } from '@/api/query-client';
import { queryKeys } from '@/api/query-keys';
import { getFunding, getOpenInterest, type DerivativesRequest } from '@/api/resources';

export function useFunding(
  request: DerivativesRequest | undefined,
): UseQueryResult<FundingResponse, ApiError> {
  return useQuery({
    queryKey: queryKeys.derivatives('funding', request),
    queryFn:
      request === undefined ? skipToken : ({ signal }) => getFunding(request, undefined, signal),
    staleTime: STALE_TIME.candles,
  });
}

export function useOpenInterest(
  request: DerivativesRequest | undefined,
): UseQueryResult<OpenInterestResponse, ApiError> {
  return useQuery({
    queryKey: queryKeys.derivatives('open-interest', request),
    queryFn:
      request === undefined
        ? skipToken
        : ({ signal }) => getOpenInterest(request, undefined, signal),
    staleTime: STALE_TIME.candles,
  });
}
