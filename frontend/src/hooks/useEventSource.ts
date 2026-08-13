import { useEffect, useRef, useState } from 'react';
import type { ZodType } from 'zod';
import {
  SSE_CLOSED,
  openSseConnection,
  resolveSseCtor,
  type SseConnection,
  type SseConnectionCtor,
} from '@/api/event-source';

export const CONNECTION_STATES = ['connecting', 'connected', 'disconnected'] as const;

export type ConnectionState = (typeof CONNECTION_STATES)[number];

export const RECONNECT_BASE_MS = 1000;
export const RECONNECT_MAX_MS = 30_000;

export interface SseEventHandler {
  readonly dispatch: (raw: string) => boolean;
}

export function sseEvent<T>(schema: ZodType<T>, onEvent: (payload: T) => void): SseEventHandler {
  return {
    dispatch(raw: string): boolean {
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        return false;
      }

      const parsed = schema.safeParse(json);
      if (!parsed.success) {
        return false;
      }

      onEvent(parsed.data);
      return true;
    },
  };
}

export interface UseEventSourceOptions {
  readonly enabled?: boolean;
  readonly reconnectBaseMs?: number;
  readonly reconnectMaxMs?: number;
  readonly ctor?: SseConnectionCtor | undefined;
  readonly onMalformed?: ((event: string, raw: string) => void) | undefined;
}

export interface UseEventSourceResult {
  readonly connectionState: ConnectionState;
  readonly reconnectAttempts: number;
}

export function backoffDelay(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
}

export function useEventSource(
  url: string | undefined,
  handlers: Readonly<Record<string, SseEventHandler>>,
  options: UseEventSourceOptions = {},
): UseEventSourceResult {
  const {
    enabled = true,
    reconnectBaseMs = RECONNECT_BASE_MS,
    reconnectMaxMs = RECONNECT_MAX_MS,
    ctor,
    onMalformed,
  } = options;

  const active = url !== undefined && enabled;

  const [socketState, setSocketState] = useState<ConnectionState | null>(null);
  const [reconnectAttempts, setReconnectAttempts] = useState(0);

  const handlersRef = useRef(handlers);
  const onMalformedRef = useRef(onMalformed);

  useEffect(() => {
    handlersRef.current = handlers;
    onMalformedRef.current = onMalformed;
  });

  const sessionKey = `${url ?? ''}|${String(enabled)}`;
  const [trackedKey, setTrackedKey] = useState(sessionKey);

  if (trackedKey !== sessionKey) {
    setTrackedKey(sessionKey);
    setSocketState(null);
    setReconnectAttempts(0);
  }

  useEffect(() => {
    if (url === undefined || !enabled) {
      return;
    }

    const Ctor = resolveSseCtor(ctor);

    if (Ctor === null) {
      return;
    }

    let disposed = false;
    let connection: SseConnection | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    const connect = (): void => {
      if (disposed) {
        return;
      }

      const current = openSseConnection(url, Ctor);
      connection = current;

      for (const name of Object.keys(handlersRef.current)) {
        current.addEventListener(name, (event: MessageEvent<string>) => {
          if (disposed) {
            return;
          }
          if (handlersRef.current[name]?.dispatch(event.data) !== true) {
            onMalformedRef.current?.(name, event.data);
          }
        });
      }

      current.onopen = () => {
        if (disposed) {
          return;
        }
        attempt = 0;
        setReconnectAttempts(0);
        setSocketState('connected');
      };

      current.onerror = () => {
        if (disposed) {
          return;
        }

        if (current.readyState !== SSE_CLOSED) {
          setSocketState('connecting');
          return;
        }

        attempt += 1;
        setReconnectAttempts(attempt);
        setSocketState('disconnected');

        retryTimer = setTimeout(
          () => {
            setSocketState('connecting');
            connect();
          },
          backoffDelay(attempt, reconnectBaseMs, reconnectMaxMs),
        );
      };
    };

    connect();

    return () => {
      disposed = true;
      if (retryTimer !== undefined) {
        clearTimeout(retryTimer);
      }
      connection?.close();
      connection = null;
    };
  }, [url, enabled, reconnectBaseMs, reconnectMaxMs, ctor]);

  return {
    connectionState: active ? (socketState ?? 'connecting') : 'disconnected',
    reconnectAttempts,
  };
}
