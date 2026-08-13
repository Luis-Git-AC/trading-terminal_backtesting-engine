import type { Timeframe } from '@tt/shared';
import { apiClient, buildUrl } from '@/api/client';

export const SSE_CONNECTING = 0;
export const SSE_OPEN = 1;
export const SSE_CLOSED = 2;

export interface SseConnection {
  readonly readyState: number;
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
}

export type SseConnectionCtor = new (url: string) => SseConnection;

export function runStreamUrl(runId: string): string {
  return buildUrl(apiClient.baseUrl, `/backtests/${encodeURIComponent(runId)}/stream`, undefined);
}

export function candleStreamUrl(symbol: string, timeframe: Timeframe): string {
  return buildUrl(apiClient.baseUrl, '/stream/candles', { symbol, timeframe });
}

export function resolveSseCtor(explicit?: SseConnectionCtor): SseConnectionCtor | null {
  if (explicit !== undefined) {
    return explicit;
  }
  return typeof globalThis.EventSource === 'function' ? globalThis.EventSource : null;
}

export function openSseConnection(url: string, ctor: SseConnectionCtor): SseConnection {
  return new ctor(url);
}
