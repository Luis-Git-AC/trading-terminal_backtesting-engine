export const SSE_RETRY_MS = 3_000;

export const SSE_HEARTBEAT_MS = 15_000;

export const SSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
});

export interface SseResponse {
  writeHead(status: number, headers: Record<string, string>): unknown;
  flushHeaders?: () => void;
  write(chunk: string): unknown;
  end(): unknown;
  on(event: 'close' | 'error', listener: () => void): unknown;
}

export interface SseChannelOptions {
  readonly retryMs?: number | undefined;
  readonly heartbeatMs?: number | undefined;
}

export interface SseChannel {
  send(event: string, data: unknown): void;
  comment(text: string): void;
  close(): void;
  onClose(listener: () => void): void;
  readonly closed: boolean;
}

export function sseChannel(res: SseResponse, options: SseChannelOptions = {}): SseChannel {
  const heartbeatMs = options.heartbeatMs ?? SSE_HEARTBEAT_MS;
  const listeners = new Set<() => void>();

  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const teardown = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    if (heartbeat !== undefined) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
    for (const listener of listeners) {
      listener();
    }
    listeners.clear();
  };

  res.on('close', teardown);
  res.on('error', teardown);

  res.writeHead(200, { ...SSE_HEADERS });
  res.flushHeaders?.();
  res.write(`retry: ${options.retryMs ?? SSE_RETRY_MS}\n\n`);

  if (heartbeatMs > 0) {
    heartbeat = setInterval(() => {
      if (!closed) {
        res.write(': ping\n\n');
      }
    }, heartbeatMs);
    heartbeat.unref?.();
  }

  return {
    get closed(): boolean {
      return closed;
    },
    send(event: string, data: unknown): void {
      if (closed) {
        return;
      }
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    comment(text: string): void {
      if (closed) {
        return;
      }
      res.write(`: ${text}\n\n`);
    },
    close(): void {
      if (closed) {
        return;
      }
      teardown();
      res.end();
    },
    onClose(listener: () => void): void {
      if (closed) {
        listener();
        return;
      }
      listeners.add(listener);
    },
  };
}
