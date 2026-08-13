import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { StrategyCatalog } from '@tt/shared';
import { STALE_TIME } from '@/api/query-client';
import { queryKeys } from '@/api/query-keys';
import { getStrategies } from '@/api/resources';

export function useStrategies(): UseQueryResult<StrategyCatalog> {
  return useQuery({
    queryKey: queryKeys.strategies(),
    queryFn: ({ signal }) => getStrategies(undefined, signal),
    staleTime: STALE_TIME.strategies,
  });
}
