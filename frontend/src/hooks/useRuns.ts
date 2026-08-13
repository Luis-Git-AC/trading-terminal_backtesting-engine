import { skipToken, useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { EquityResponse, ListBacktestsResponse, RunDetail, TradesResponse } from '@tt/shared';
import { STALE_TIME } from '@/api/query-client';
import { queryKeys } from '@/api/query-keys';
import {
  getRun,
  getRunEquity,
  getRunTrades,
  listRuns,
  type RunsRequest,
  type TradesRequest,
} from '@/api/resources';

export function useRuns(request: RunsRequest = {}): UseQueryResult<ListBacktestsResponse> {
  return useQuery({
    queryKey: queryKeys.runList(request),
    queryFn: ({ signal }) => listRuns(request, undefined, signal),
    staleTime: STALE_TIME.runs,
  });
}

export function useRun(runId: string | undefined): UseQueryResult<RunDetail> {
  return useQuery({
    queryKey: queryKeys.run(runId),
    queryFn: runId === undefined ? skipToken : ({ signal }) => getRun(runId, undefined, signal),
    staleTime: STALE_TIME.runs,
  });
}

export function useRunTrades(request: TradesRequest | undefined): UseQueryResult<TradesResponse> {
  return useQuery({
    queryKey: queryKeys.runTrades(request),
    queryFn:
      request === undefined ? skipToken : ({ signal }) => getRunTrades(request, undefined, signal),
    staleTime: STALE_TIME.runs,
  });
}

export function useRunEquity(runId: string | undefined): UseQueryResult<EquityResponse> {
  return useQuery({
    queryKey: queryKeys.runEquity(runId),
    queryFn:
      runId === undefined ? skipToken : ({ signal }) => getRunEquity(runId, undefined, signal),
    staleTime: STALE_TIME.runs,
  });
}
