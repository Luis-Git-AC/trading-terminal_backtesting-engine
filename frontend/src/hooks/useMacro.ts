import { skipToken, useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { EventsResponse, MacroSeriesResponse } from '@tt/shared';
import type { ApiError } from '@/api/errors';
import { STALE_TIME } from '@/api/query-client';
import { queryKeys } from '@/api/query-keys';
import {
  getMacroSeries,
  getMarketEvents,
  type EventsRequest,
  type MacroRequest,
} from '@/api/resources';

export function useMacroSeries(
  request: MacroRequest | undefined,
): UseQueryResult<MacroSeriesResponse, ApiError> {
  return useQuery({
    queryKey: queryKeys.macro(request),
    queryFn:
      request === undefined ? skipToken : ({ signal }) => getMacroSeries(request, undefined, signal),
    staleTime: STALE_TIME.candles,
  });
}

export function useMarketEvents(
  request: EventsRequest | undefined,
): UseQueryResult<EventsResponse, ApiError> {
  return useQuery({
    queryKey: queryKeys.events(request),
    queryFn:
      request === undefined
        ? skipToken
        : ({ signal }) => getMarketEvents(request, undefined, signal),
    staleTime: STALE_TIME.candles,
  });
}
