import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { HealthResponse } from '@tt/shared';
import type { ApiError } from '@/api/errors';
import { STALE_TIME } from '@/api/query-client';
import { queryKeys } from '@/api/query-keys';
import { getHealth } from '@/api/resources';

export const HEALTH_REFETCH_MS = 15_000;

export function useHealth(): UseQueryResult<HealthResponse, ApiError> {
  return useQuery({
    queryKey: queryKeys.health(),
    queryFn: ({ signal }) => getHealth(undefined, signal),
    staleTime: STALE_TIME.health,
    refetchInterval: HEALTH_REFETCH_MS,
  });
}
