import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { RunStatus } from '@tt/shared';
import { runStreamUrl } from '@/api/event-source';
import { queryKeys } from '@/api/query-keys';
import {
  runDonePayloadSchema,
  runErrorPayloadSchema,
  runProgressPayloadSchema,
  runStatusPayloadSchema,
  type RunErrorPayload,
  type RunProgressPayload,
} from '@/api/sse-events';
import type { SseConnectionCtor } from '@/api/event-source';
import { sseEvent, useEventSource, type ConnectionState } from '@/hooks/useEventSource';

const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'] as const;

export function isTerminalStatus(status: RunStatus | undefined): boolean {
  return status !== undefined && TERMINAL_STATUSES.some((terminal) => terminal === status);
}

export interface UseRunProgressResult {
  readonly status: RunStatus | undefined;
  readonly barsTotal: number | undefined;
  readonly progress: RunProgressPayload | undefined;
  readonly error: RunErrorPayload | undefined;
  readonly finished: boolean;
  readonly connectionState: ConnectionState;
}

export interface UseRunProgressOptions {
  readonly ctor?: SseConnectionCtor | undefined;
}

export function useRunProgress(
  runId: string | undefined,
  options: UseRunProgressOptions = {},
): UseRunProgressResult {
  const queryClient = useQueryClient();

  const [status, setStatus] = useState<RunStatus | undefined>(undefined);
  const [barsTotal, setBarsTotal] = useState<number | undefined>(undefined);
  const [progress, setProgress] = useState<RunProgressPayload | undefined>(undefined);
  const [error, setError] = useState<RunErrorPayload | undefined>(undefined);
  const [finished, setFinished] = useState(false);

  const [trackedRunId, setTrackedRunId] = useState(runId);

  if (trackedRunId !== runId) {
    setTrackedRunId(runId);
    setStatus(undefined);
    setBarsTotal(undefined);
    setProgress(undefined);
    setError(undefined);
    setFinished(false);
  }

  const invalidatedRef = useRef<string | null>(null);

  const handlers = {
    status: sseEvent(runStatusPayloadSchema, (payload) => {
      setStatus(payload.status);
      setBarsTotal(payload.barsTotal);
    }),
    progress: sseEvent(runProgressPayloadSchema, (payload) => {
      setProgress(payload);
    }),
    // eslint-disable-next-line react-hooks/refs
    done: sseEvent(runDonePayloadSchema, (payload) => {
      setStatus(payload.status);
      setFinished(true);
      if (invalidatedRef.current !== payload.runId) {
        invalidatedRef.current = payload.runId;
        void queryClient.invalidateQueries({ queryKey: queryKeys.run(payload.runId) });
      }
    }),
    error: sseEvent(runErrorPayloadSchema, (payload) => {
      setError(payload);
    }),
  };

  const { connectionState } = useEventSource(
    runId === undefined ? undefined : runStreamUrl(runId),
    handlers,
    { enabled: !finished, ctor: options.ctor },
  );

  return { status, barsTotal, progress, error, finished, connectionState };
}
