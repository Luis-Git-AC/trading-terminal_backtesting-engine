import { QueryClient } from '@tanstack/react-query';
import { isApiError } from '@/api/errors';

const SECOND = 1000;

export const STALE_TIME = {
  health: 10 * SECOND,
  markets: 10 * 60 * SECOND,
  strategies: 10 * 60 * SECOND,
  candles: 5 * 60 * SECOND,
  coverage: 30 * SECOND,
  runs: 0,
} as const;

export const MAX_QUERY_RETRIES = 2;

export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= MAX_QUERY_RETRIES) {
    return false;
  }

  if (!isApiError(error)) {
    return false;
  }

  if (error.code === 'NETWORK_ERROR') {
    return true;
  }

  return error.status !== null && error.status >= 500;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: STALE_TIME.runs,
        retry: shouldRetry,
        refetchOnWindowFocus: false,
      },
      mutations: {
        retry: false,
      },
    },
  });
}
