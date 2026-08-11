import { Buffer } from 'node:buffer';
import { WebSocket, type RawData } from 'ws';

export type SocketState = 'idle' | 'connecting' | 'open' | 'closing' | 'closed';

export const DEFAULT_RECONNECT_BASE_MS = 1000;
export const DEFAULT_RECONNECT_MAX_MS = 30_000;
export const DEFAULT_STALE_TIMEOUT_MS = 45_000;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 20_000;
export const DEFAULT_STABLE_RESET_MS = 60_000;
export const DEFAULT_CLOSE_GRACE_MS = 1000;
export const DEFAULT_HEARTBEAT_MESSAGE = 'ping';
export const DEFAULT_HEARTBEAT_RESPONSE = 'pong';
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 10;

export interface SocketHandlers {
  open(): void;
  message(data: string): void;
  error(error: Error): void;
  close(code: number, reason: string): void;
}

export interface SocketLike {
  send(message: string): void;
  close(): void;
  terminate(): void;
  dispose(): void;
  readonly listenerCount: number;
}

export type SocketFactory = (url: string, handlers: SocketHandlers) => SocketLike;

export type ResilientSocketEvent =
  | { kind: 'state'; from: SocketState; to: SocketState }
  | { kind: 'message'; data: string }
  | { kind: 'reconnect'; attempt: number; delayMs: number; reason: string }
  | { kind: 'degraded'; consecutiveFailures: number; delayMs: number; reason: string }
  | { kind: 'stale'; idleMs: number }
  | { kind: 'error'; error: Error };

export type ResilientSocketListener = (event: ResilientSocketEvent) => void;

export interface ResilientSocketOptions {
  url: string;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  staleTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  stableResetMs?: number;
  closeGraceMs?: number;
  maxConsecutiveFailures?: number;
  heartbeatMessage?: string;
  heartbeatResponse?: string;
  createSocket?: SocketFactory;
  random?: () => number;
}

export interface ResilientSocket {
  readonly url: string;
  readonly state: SocketState;
  readonly reconnectAttempts: number;
  readonly consecutiveFailures: number;
  readonly degraded: boolean;
  readonly subscriptionIds: readonly string[];
  on(listener: ResilientSocketListener): () => void;
  connect(): void;
  send(message: string): boolean;
  subscribe(id: string, message: string): void;
  unsubscribe(id: string, message?: string): void;
  close(): Promise<void>;
}

export function rawDataToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

export function createWebSocketFactory(): SocketFactory {
  return (url, handlers) => {
    const socket = new WebSocket(url);

    socket.on('open', () => {
      handlers.open();
    });
    socket.on('message', (data: RawData) => {
      handlers.message(rawDataToString(data));
    });
    socket.on('error', (error: Error) => {
      handlers.error(error);
    });
    socket.on('close', (code: number, reason: Buffer) => {
      handlers.close(code, reason.toString('utf8'));
    });

    return {
      send: (message) => {
        socket.send(message);
      },
      close: () => {
        socket.close();
      },
      terminate: () => {
        socket.terminate();
      },
      dispose: () => {
        socket.removeAllListeners();
      },
      get listenerCount() {
        return socket
          .eventNames()
          .reduce((total, event) => total + socket.listenerCount(event), 0);
      },
    };
  };
}

function positiveMs(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} debe ser un numero positivo y finito, recibido: ${value}`);
  }
  return value;
}

function nonNegativeMs(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} debe ser un numero no negativo y finito, recibido: ${value}`);
  }
  return value;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function createResilientSocket(options: ResilientSocketOptions): ResilientSocket {
  const url = options.url;
  const reconnectBaseMs = positiveMs(
    'reconnectBaseMs',
    options.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS,
  );
  const reconnectMaxMs = positiveMs(
    'reconnectMaxMs',
    options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS,
  );
  const staleTimeoutMs = nonNegativeMs(
    'staleTimeoutMs',
    options.staleTimeoutMs ?? DEFAULT_STALE_TIMEOUT_MS,
  );
  const heartbeatIntervalMs = nonNegativeMs(
    'heartbeatIntervalMs',
    options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
  );
  const stableResetMs = positiveMs('stableResetMs', options.stableResetMs ?? DEFAULT_STABLE_RESET_MS);
  const closeGraceMs = positiveMs('closeGraceMs', options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS);
  const maxConsecutiveFailures = positiveMs(
    'maxConsecutiveFailures',
    options.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES,
  );
  const heartbeatMessage = options.heartbeatMessage ?? DEFAULT_HEARTBEAT_MESSAGE;
  const heartbeatResponse = options.heartbeatResponse ?? DEFAULT_HEARTBEAT_RESPONSE;
  const createSocket = options.createSocket ?? createWebSocketFactory();
  const random = options.random ?? Math.random;

  if (reconnectMaxMs < reconnectBaseMs) {
    throw new RangeError(
      `reconnectMaxMs (${reconnectMaxMs}) no puede ser menor que reconnectBaseMs (${reconnectBaseMs})`,
    );
  }

  const listeners = new Set<ResilientSocketListener>();
  const subscriptions = new Map<string, string>();
  const closeWaiters: (() => void)[] = [];

  let state: SocketState = 'idle';
  let socket: SocketLike | undefined;
  let attempts = 0;
  let closedByUser = false;
  let generation = 0;

  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let staleTimer: ReturnType<typeof setTimeout> | undefined;
  let stableTimer: ReturnType<typeof setTimeout> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  function emit(event: ResilientSocketEvent): void {
    for (const listener of [...listeners]) listener(event);
  }

  function setState(next: SocketState): void {
    if (state === next) return;
    const from = state;
    state = next;
    emit({ kind: 'state', from, to: next });
  }

  function armStale(): void {
    if (staleTimeoutMs === 0) return;
    clearTimeout(staleTimer);
    staleTimer = setTimeout(onStale, staleTimeoutMs);
  }

  function teardownSocket(): void {
    clearTimeout(staleTimer);
    clearTimeout(stableTimer);
    clearInterval(heartbeatTimer);
    staleTimer = undefined;
    stableTimer = undefined;
    heartbeatTimer = undefined;

    if (socket !== undefined) {
      socket.dispose();
      socket = undefined;
    }
  }

  function settleClosed(): void {
    setState('closed');
    if (closeWaiters.length === 0) return;
    const waiters = closeWaiters.splice(0, closeWaiters.length);
    for (const resolve of waiters) resolve();
  }

  function scheduleReconnect(reason: string): void {
    attempts += 1;

    const degraded = attempts >= maxConsecutiveFailures;
    const ceiling = degraded
      ? reconnectMaxMs
      : Math.min(reconnectMaxMs, reconnectBaseMs * 2 ** (attempts - 1));
    const delayMs = degraded ? reconnectMaxMs : Math.round(random() * ceiling);

    emit({ kind: 'reconnect', attempt: attempts, delayMs, reason });
    if (degraded) {
      emit({ kind: 'degraded', consecutiveFailures: attempts, delayMs, reason });
    }

    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delayMs);
  }

  function onStale(): void {
    const current = socket;
    staleTimer = undefined;
    emit({ kind: 'stale', idleMs: staleTimeoutMs });

    if (current !== undefined) {
      try {
        current.terminate();
      } catch (error) {
        emit({ kind: 'error', error: toError(error) });
      }
    }

    teardownSocket();
    settleClosed();
    if (!closedByUser) scheduleReconnect('watchdog: sin mensajes');
  }

  function connect(): void {
    if (state === 'connecting' || state === 'open' || state === 'closing') return;

    closedByUser = false;
    generation += 1;
    const mine = generation;
    setState('connecting');

    const handlers: SocketHandlers = {
      open() {
        if (mine !== generation) return;
        setState('open');
        armStale();

        stableTimer = setTimeout(() => {
          stableTimer = undefined;
          attempts = 0;
        }, stableResetMs);

        if (heartbeatIntervalMs > 0) {
          heartbeatTimer = setInterval(() => {
            send(heartbeatMessage);
          }, heartbeatIntervalMs);
        }

        for (const message of subscriptions.values()) send(message);
      },

      message(data) {
        if (mine !== generation) return;
        armStale();
        if (data === heartbeatResponse) return;
        emit({ kind: 'message', data });
      },

      error(error) {
        if (mine !== generation) return;
        emit({ kind: 'error', error });
      },

      close(code, reason) {
        if (mine !== generation) return;
        teardownSocket();
        clearTimeout(closeTimer);
        closeTimer = undefined;

        const wasUser = closedByUser;
        settleClosed();
        if (!wasUser) scheduleReconnect(`cierre del socket (${code}${reason ? ` ${reason}` : ''})`);
      },
    };

    try {
      socket = createSocket(url, handlers);
    } catch (error) {
      emit({ kind: 'error', error: toError(error) });
      settleClosed();
      scheduleReconnect(`no se pudo abrir el socket: ${describe(error)}`);
    }
  }

  function send(message: string): boolean {
    if (state !== 'open' || socket === undefined) return false;
    try {
      socket.send(message);
      return true;
    } catch (error) {
      emit({ kind: 'error', error: toError(error) });
      return false;
    }
  }

  return {
    url,

    get state() {
      return state;
    },

    get reconnectAttempts() {
      return attempts;
    },

    get consecutiveFailures() {
      return attempts;
    },

    get degraded() {
      return attempts >= maxConsecutiveFailures;
    },

    get subscriptionIds() {
      return [...subscriptions.keys()];
    },

    on(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    connect,
    send,

    subscribe(id, message) {
      subscriptions.set(id, message);
      send(message);
    },

    unsubscribe(id, message) {
      subscriptions.delete(id);
      if (message !== undefined) send(message);
    },

    close() {
      closedByUser = true;
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;

      if (socket === undefined) {
        teardownSocket();
        settleClosed();
        return Promise.resolve();
      }

      const closing = new Promise<void>((resolve) => {
        closeWaiters.push(resolve);
      });

      setState('closing');

      const current = socket;
      closeTimer = setTimeout(() => {
        closeTimer = undefined;
        try {
          current.terminate();
        } catch (error) {
          emit({ kind: 'error', error: toError(error) });
        }
        teardownSocket();
        settleClosed();
      }, closeGraceMs);

      try {
        current.close();
      } catch (error) {
        emit({ kind: 'error', error: toError(error) });
      }

      return closing;
    },
  };
}
