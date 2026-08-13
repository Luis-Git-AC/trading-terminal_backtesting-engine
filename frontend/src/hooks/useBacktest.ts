import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import type {
  CancelBacktestResponse,
  CreateBacktestBody,
  CreateBacktestResponse,
} from '@tt/shared';
import type { ApiError } from '@/api/errors';
import { queryKeys } from '@/api/query-keys';
import { cancelBacktest, createBacktest, deleteBacktest } from '@/api/resources';

export function useCreateBacktest(): UseMutationResult<
  CreateBacktestResponse,
  ApiError,
  CreateBacktestBody
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (body: CreateBacktestBody) => createBacktest(body),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.runs() });
    },
  });
}

export function useCancelBacktest(): UseMutationResult<CancelBacktestResponse, ApiError, string> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (runId: string) => cancelBacktest(runId),
    onSuccess: async (_data, runId) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.run(runId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.runs() });
    },
  });
}

export function useDeleteBacktest(): UseMutationResult<void, ApiError, string> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (runId: string) => deleteBacktest(runId),
    onSuccess: async (_data, runId) => {
      queryClient.removeQueries({ queryKey: queryKeys.run(runId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.runs() });
    },
  });
}
