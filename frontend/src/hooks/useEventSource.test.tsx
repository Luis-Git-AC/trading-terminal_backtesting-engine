import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { backoffDelay, sseEvent, useEventSource } from '@/hooks/useEventSource';
import { FakeEventSource } from '@/test/fake-event-source';

const payloadSchema = z.object({ value: z.number() });

beforeEach(() => {
  FakeEventSource.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

function handlersFor(seen: unknown[]) {
  return {
    tick: sseEvent(payloadSchema, (payload) => {
      seen.push(payload);
    }),
  };
}

describe('backoffDelay', () => {
  it('crece exponencialmente desde la base', () => {
    expect(backoffDelay(1, 1000, 30_000)).toBe(1000);
    expect(backoffDelay(2, 1000, 30_000)).toBe(2000);
    expect(backoffDelay(3, 1000, 30_000)).toBe(4000);
  });

  it('nunca supera el techo', () => {
    expect(backoffDelay(20, 1000, 30_000)).toBe(30_000);
  });
});

describe('sseEvent', () => {
  it('parsea el payload y lo entrega tipado', () => {
    const seen: unknown[] = [];
    const handler = sseEvent(payloadSchema, (payload) => seen.push(payload));

    expect(handler.dispatch('{"value":7}')).toBe(true);
    expect(seen).toEqual([{ value: 7 }]);
  });

  it('descarta lo que no es JSON o no cumple el esquema, sin lanzar', () => {
    const seen: unknown[] = [];
    const handler = sseEvent(payloadSchema, (payload) => seen.push(payload));

    expect(handler.dispatch('no soy json')).toBe(false);
    expect(handler.dispatch('{"value":"texto"}')).toBe(false);
    expect(seen).toEqual([]);
  });
});

describe('useEventSource', () => {
  it('abre la conexion con la url pedida y entrega los eventos nombrados', async () => {
    const seen: unknown[] = [];
    const { result } = renderHook(() =>
      useEventSource('http://api.test/api/stream', handlersFor(seen), {
        ctor: FakeEventSource,
      }),
    );

    expect(FakeEventSource.openCount).toBe(1);
    expect(FakeEventSource.last().url).toBe('http://api.test/api/stream');

    act(() => {
      FakeEventSource.last().open();
    });
    await waitFor(() => {
      expect(result.current.connectionState).toBe('connected');
    });

    act(() => {
      FakeEventSource.last().emit('tick', { value: 42 });
    });

    expect(seen).toEqual([{ value: 42 }]);
  });

  it('avisa por onMalformed de un payload que no cumple el contrato', () => {
    const malformed: string[] = [];
    renderHook(() =>
      useEventSource('http://api.test/api/stream', handlersFor([]), {
        ctor: FakeEventSource,
        onMalformed: (event, raw) => malformed.push(`${event}:${raw}`),
      }),
    );

    act(() => {
      FakeEventSource.last().emit('tick', { value: 'no soy numero' });
    });

    expect(malformed).toEqual(['tick:{"value":"no soy numero"}']);
  });

  it('desmontar cierra el EventSource', () => {
    const { unmount } = renderHook(() =>
      useEventSource('http://api.test/api/stream', handlersFor([]), { ctor: FakeEventSource }),
    );

    const connection = FakeEventSource.last();
    expect(connection.closeCalls).toBe(0);

    unmount();

    expect(connection.closeCalls).toBe(1);
  });

  it('sin url no abre nada y queda desconectado', () => {
    const { result } = renderHook(() =>
      useEventSource(undefined, handlersFor([]), { ctor: FakeEventSource }),
    );

    expect(FakeEventSource.openCount).toBe(0);
    expect(result.current.connectionState).toBe('disconnected');
  });

  it('con enabled:false no abre nada', () => {
    renderHook(() =>
      useEventSource('http://api.test/api/stream', handlersFor([]), {
        ctor: FakeEventSource,
        enabled: false,
      }),
    );

    expect(FakeEventSource.openCount).toBe(0);
  });

  it('pasar enabled a false cierra la conexion abierta', () => {
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useEventSource('http://api.test/api/stream', handlersFor([]), {
          ctor: FakeEventSource,
          enabled,
        }),
      { initialProps: { enabled: true } },
    );

    const connection = FakeEventSource.last();
    rerender({ enabled: false });

    expect(connection.closeCalls).toBe(1);
    expect(FakeEventSource.openCount).toBe(1);
  });

  it('un corte del que el navegador se recupera solo no dispara reconexion propia', () => {
    const { result } = renderHook(() =>
      useEventSource('http://api.test/api/stream', handlersFor([]), { ctor: FakeEventSource }),
    );

    act(() => {
      FakeEventSource.last().dropRetrying();
    });

    expect(FakeEventSource.openCount).toBe(1);
    expect(result.current.connectionState).toBe('connecting');
  });

  it('si el navegador se rinde, reconecta con backoff y sin duplicar handlers', () => {
    vi.useFakeTimers();
    const seen: unknown[] = [];

    const { result } = renderHook(() =>
      useEventSource('http://api.test/api/stream', handlersFor(seen), {
        ctor: FakeEventSource,
        reconnectBaseMs: 1000,
        reconnectMaxMs: 30_000,
      }),
    );

    const first = FakeEventSource.last();
    expect(first.listenerCount('tick')).toBe(1);

    act(() => {
      first.dropGivingUp();
    });
    expect(result.current.connectionState).toBe('disconnected');
    expect(result.current.reconnectAttempts).toBe(1);
    expect(FakeEventSource.openCount).toBe(1);

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(FakeEventSource.openCount).toBe(2);
    const second = FakeEventSource.last();
    expect(second).not.toBe(first);
    expect(second.listenerCount('tick')).toBe(1);

    act(() => {
      second.open();
      second.emit('tick', { value: 1 });
    });

    expect(seen).toEqual([{ value: 1 }]);
  });

  it('el retardo entre reintentos crece con cada fallo seguido', () => {
    vi.useFakeTimers();

    renderHook(() =>
      useEventSource('http://api.test/api/stream', handlersFor([]), {
        ctor: FakeEventSource,
        reconnectBaseMs: 1000,
        reconnectMaxMs: 30_000,
      }),
    );

    act(() => {
      FakeEventSource.last().dropGivingUp();
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(FakeEventSource.openCount).toBe(2);

    act(() => {
      FakeEventSource.last().dropGivingUp();
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(FakeEventSource.openCount).toBe(2);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(FakeEventSource.openCount).toBe(3);
  });

  it('una reconexion exitosa vuelve a poner el contador a cero', () => {
    vi.useFakeTimers();

    const { result } = renderHook(() =>
      useEventSource('http://api.test/api/stream', handlersFor([]), {
        ctor: FakeEventSource,
        reconnectBaseMs: 1000,
      }),
    );

    act(() => {
      FakeEventSource.last().dropGivingUp();
    });
    expect(result.current.reconnectAttempts).toBe(1);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    act(() => {
      FakeEventSource.last().open();
    });

    expect(result.current.reconnectAttempts).toBe(0);
    expect(result.current.connectionState).toBe('connected');
  });

  it('desmontar durante la espera de reconexion no abre una conexion nueva', () => {
    vi.useFakeTimers();

    const { unmount } = renderHook(() =>
      useEventSource('http://api.test/api/stream', handlersFor([]), {
        ctor: FakeEventSource,
        reconnectBaseMs: 1000,
      }),
    );

    act(() => {
      FakeEventSource.last().dropGivingUp();
    });

    unmount();

    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(FakeEventSource.openCount).toBe(1);
  });

  it('cambiar de url cierra la anterior y abre la nueva', () => {
    const { rerender } = renderHook(
      ({ url }: { url: string }) => useEventSource(url, handlersFor([]), { ctor: FakeEventSource }),
      { initialProps: { url: 'http://api.test/api/a' } },
    );

    const first = FakeEventSource.last();
    rerender({ url: 'http://api.test/api/b' });

    expect(first.closeCalls).toBe(1);
    expect(FakeEventSource.openCount).toBe(2);
    expect(FakeEventSource.last().url).toBe('http://api.test/api/b');
  });

  it('cambiar los handlers no reabre la conexion', () => {
    const seen: unknown[] = [];

    const { rerender } = renderHook(() =>
      useEventSource('http://api.test/api/stream', handlersFor(seen), { ctor: FakeEventSource }),
    );

    rerender();
    rerender();

    expect(FakeEventSource.openCount).toBe(1);
    expect(FakeEventSource.last().listenerCount('tick')).toBe(1);
  });
});
