import { skipToken, useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { CompareResponse } from '@tt/shared';
import type { ApiError } from '@/api/errors';
import { STALE_TIME } from '@/api/query-client';
import { queryKeys } from '@/api/query-keys';
import { compareRuns } from '@/api/resources';
import { canCompare } from '@/components/Compare/compare';

export function useCompareRuns(ids: readonly string[]): UseQueryResult<CompareResponse, ApiError> {
  return useQuery({
    queryKey: queryKeys.runCompare(ids),
    queryFn: canCompare(ids) ? ({ signal }) => compareRuns(ids, undefined, signal) : skipToken,
    staleTime: STALE_TIME.runs,
  });
}
