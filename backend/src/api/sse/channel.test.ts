import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SSE_HEADERS,
  SSE_HEARTBEAT_MS,
  SSE_RETRY_MS,
  sseChannel,
  type SseResponse,
} from './channel.js';

interface FakeResponse extends SseResponse {
  readonly chunks: string[];
  readonly status: number | null;
  readonly headers: Record<string, string>;
  readonly ended: boolean;
  readonly flushed: number;
  fire(event: 'close' | 'error'): void;
  text(): string;
}

function fakeResponse(): FakeResponse {
  const chunks: string[] = [];
  const listeners = new Map<string, (() => void)[]>();
  let status: number | null = null;
  let headers: Record<string, string> = {};
  let ended = false;
  let flushed = 0;

  return {
    chunks,
    get status(): number | null {
      return status;
    },
    get headers(): Record<string, string> {
      return headers;
    },
    get ended(): boolean {
      return ended;
    },
    get flushed(): number {
      return flushed;
    },
    writeHead(code: number, sent: Record<string, string>) {
      status = code;
      headers = sent;
      return this;
    },
    flushHeaders() {
      flushed += 1;
    },
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    end() {
      ended = true;
      return this;
    },
    on(event: 'close' | 'error', listener: () => void) {
      const current = listeners.get(event) ?? [];
      current.push(listener);
      listeners.set(event, current);
      return this;
    },
    fire(event: 'close' | 'error') {
      for (const listener of listeners.get(event) ?? []) listener();
    },
    text() {
      return chunks.join('');
    },
  };
}

describe('sseChannel', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('escribe las cabeceras del contrato y las vuelca antes de nada', () => {
    const res = fakeResponse();

    sseChannel(res);

    expect(res.status).toBe(200);
    expect(res.headers['Content-Type']).toBe('text/event-stream; charset=utf-8');
    expect(res.headers['Cache-Control']).toBe('no-cache, no-transform');
    expect(res.headers.Connection).toBe('keep-alive');
    expect(res.headers['X-Accel-Buffering']).toBe('no');
    expect(res.flushed).toBe(1);
  });

  it('abre con la directiva retry', () => {
    const res = fakeResponse();

    sseChannel(res);

    expect(res.chunks[0]).toBe(`retry: ${SSE_RETRY_MS}\n\n`);
  });

  it('serializa cada evento con su nombre y su json en una sola linea de data', () => {
    const res = fakeResponse();
    const channel = sseChannel(res);

    channel.send('progress', { pct: 34.2, barsDone: 5975 });

    expect(res.chunks[1]).toBe('event: progress\ndata: {"pct":34.2,"barsDone":5975}\n\n');
  });

  it('manda un heartbeat cada 15 s (reloj falso)', () => {
    vi.useFakeTimers();
    const res = fakeResponse();
    sseChannel(res);

    expect(res.text()).not.toContain(': ping');

    vi.advanceTimersByTime(SSE_HEARTBEAT_MS - 1);
    expect(res.text()).not.toContain(': ping');

    vi.advanceTimersByTime(1);
    expect(res.text()).toContain(': ping\n\n');

    vi.advanceTimersByTime(SSE_HEARTBEAT_MS * 3);
    expect(res.chunks.filter((chunk) => chunk === ': ping\n\n')).toHaveLength(4);
  });

  it('el heartbeat se para al cerrarse el cliente y no deja el temporizador vivo', () => {
    vi.useFakeTimers();
    const res = fakeResponse();
    sseChannel(res);

    vi.advanceTimersByTime(SSE_HEARTBEAT_MS);
    expect(vi.getTimerCount()).toBe(1);

    res.fire('close');
    vi.advanceTimersByTime(SSE_HEARTBEAT_MS * 5);

    expect(res.chunks.filter((chunk) => chunk === ': ping\n\n')).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('un close del cliente avisa a los oyentes una sola vez y marca el canal cerrado', () => {
    const res = fakeResponse();
    const channel = sseChannel(res);
    const released = vi.fn();
    channel.onClose(released);

    res.fire('close');
    res.fire('close');
    res.fire('error');

    expect(released).toHaveBeenCalledTimes(1);
    expect(channel.closed).toBe(true);
  });

  it('un error del socket tambien libera', () => {
    const res = fakeResponse();
    const channel = sseChannel(res);
    const released = vi.fn();
    channel.onClose(released);

    res.fire('error');

    expect(released).toHaveBeenCalledTimes(1);
    expect(channel.closed).toBe(true);
  });

  it('onClose sobre un canal ya cerrado ejecuta el listener en el acto', () => {
    const res = fakeResponse();
    const channel = sseChannel(res);
    res.fire('close');

    const released = vi.fn();
    channel.onClose(released);

    expect(released).toHaveBeenCalledTimes(1);
  });

  it('no escribe nada despues de cerrarse', () => {
    const res = fakeResponse();
    const channel = sseChannel(res);
    const before = res.chunks.length;

    res.fire('close');
    channel.send('progress', { pct: 100 });
    channel.comment('ping');

    expect(res.chunks).toHaveLength(before);
  });

  it('close() termina la respuesta y es idempotente', () => {
    const res = fakeResponse();
    const channel = sseChannel(res);

    channel.close();
    channel.close();

    expect(res.ended).toBe(true);
    expect(channel.closed).toBe(true);
  });

  it('sin heartbeat configurado no programa temporizadores', () => {
    vi.useFakeTimers();
    const res = fakeResponse();

    sseChannel(res, { heartbeatMs: 0 });
    vi.advanceTimersByTime(SSE_HEARTBEAT_MS * 10);

    expect(res.text()).not.toContain(': ping');
  });

  it('el retry es configurable', () => {
    const res = fakeResponse();

    sseChannel(res, { retryMs: 500 });

    expect(res.chunks[0]).toBe('retry: 500\n\n');
  });

  it('las cabeceras publicadas son inmutables', () => {
    expect(Object.isFrozen(SSE_HEADERS)).toBe(true);
  });
});
