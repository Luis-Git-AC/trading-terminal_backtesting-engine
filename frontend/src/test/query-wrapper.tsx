import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor, type RenderHookResult } from '@testing-library/react';

export function silentQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0, gcTime: 0, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}

export function renderHookWithQuery<TResult>(
  hook: () => TResult,
  queryClient?: QueryClient,
): RenderHookResult<TResult, void> & { queryClient: QueryClient };

export function renderHookWithQuery<TProps, TResult>(
  hook: (props: TProps) => TResult,
  queryClient: QueryClient | undefined,
  initialProps: TProps,
): RenderHookResult<TResult, TProps> & { queryClient: QueryClient };

export function renderHookWithQuery<TProps, TResult>(
  hook: (props: TProps) => TResult,
  queryClient: QueryClient = silentQueryClient(),
  initialProps?: TProps,
) {
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }

  const result = renderHook(hook, { wrapper: Wrapper, initialProps: initialProps as TProps });

  return Object.assign(result, { queryClient });
}

export async function waitForSuccess(result: {
  current: { isSuccess: boolean; isError: boolean; error: unknown };
}): Promise<void> {
  await waitFor(() => {
    if (result.current.isError) {
      throw new Error(`La query fallo: ${String(result.current.error)}`);
    }
    if (!result.current.isSuccess) {
      throw new Error('Todavia no ha resuelto');
    }
  });
}
