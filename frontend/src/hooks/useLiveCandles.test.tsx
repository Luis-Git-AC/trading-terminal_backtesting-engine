import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Candle } from '@tt/shared';
import { useLiveCandles } from '@/hooks/useLiveCandles';
import { FakeEventSource } from '@/test/fake-event-source';

const BASE = { t: 1_785_000_000_000, o: 100, h: 105, l: 99, c: 103, v: 5 };

beforeEach(() => {
  FakeEventSource.reset();
});

function tick(overrides: Partial<Candle> & { closed: boolean }) {
  return { ...BASE, ...overrides };
}

describe('useLiveCandles', () => {
  it('abre el stream de velas con simbolo y timeframe en la query', () => {
    renderHook(() => useLiveCandles('BTCUSDT', '1m', { ctor: FakeEventSource }));

    const url = FakeEventSource.last().url;
    expect(url).toContain('/api/stream/candles');
    expect(url).toContain('symbol=BTCUSDT');
    expect(url).toContain('timeframe=1m');
  });

  it('una vela en formacion actualiza forming y no toca lastClosed', async () => {
    const { result } = renderHook(() => useLiveCandles('BTCUSDT', '1m', { ctor: FakeEventSource }));

    act(() => {
      FakeEventSource.last().emit('candle', tick({ closed: false, c: 101 }));
    });

    await waitFor(() => {
      expect(result.current.forming?.c).toBe(101);
    });
    expect(result.current.lastClosed).toBeUndefined();

    act(() => {
      FakeEventSource.last().emit('candle', tick({ closed: false, c: 104 }));
    });

    expect(result.current.forming?.c).toBe(104);
    expect(result.current.lastClosed).toBeUndefined();
  });

  it('una vela cerrada pasa a lastClosed y limpia la que se estaba formando', async () => {
    const { result } = renderHook(() => useLiveCandles('BTCUSDT', '1m', { ctor: FakeEventSource }));

    act(() => {
      FakeEventSource.last().emit('candle', tick({ closed: false, c: 101 }));
    });
    act(() => {
      FakeEventSource.last().emit('candle', tick({ closed: true, c: 104 }));
    });

    await waitFor(() => {
      expect(result.current.lastClosed?.c).toBe(104);
    });
    expect(result.current.forming).toBeUndefined();
  });

  it('el callback recibe cada tick con su flag de cierre, sin esperar al render', () => {
    const seen: [number, boolean][] = [];

    renderHook(() =>
      useLiveCandles('BTCUSDT', '1m', {
        ctor: FakeEventSource,
        onTick: (candle, closed) => seen.push([candle.c, closed]),
      }),
    );

    act(() => {
      FakeEventSource.last().emit('candle', tick({ closed: false, c: 101 }));
      FakeEventSource.last().emit('candle', tick({ closed: false, c: 102 }));
      FakeEventSource.last().emit('candle', tick({ closed: true, c: 103 }));
    });

    expect(seen).toEqual([
      [101, false],
      [102, false],
      [103, true],
    ]);
  });

  it('el callback no lleva el flag closed dentro de la vela que entrega', () => {
    const seen: Candle[] = [];

    renderHook(() =>
      useLiveCandles('BTCUSDT', '1m', {
        ctor: FakeEventSource,
        onTick: (candle) => seen.push(candle),
      }),
    );

    act(() => {
      FakeEventSource.last().emit('candle', tick({ closed: true }));
    });

    expect(seen[0]).toEqual(BASE);
    expect(Object.keys(seen[0] ?? {})).not.toContain('closed');
  });

  it('un tick que no cumple el esquema se descarta sin romper el estado', async () => {
    const { result } = renderHook(() => useLiveCandles('BTCUSDT', '1m', { ctor: FakeEventSource }));

    act(() => {
      FakeEventSource.last().emit('candle', tick({ closed: false, c: 101 }));
    });
    await waitFor(() => {
      expect(result.current.forming?.c).toBe(101);
    });

    act(() => {
      FakeEventSource.last().emit('candle', { ...BASE, h: 1, closed: false });
    });

    expect(result.current.forming?.c).toBe(101);
  });

  it('sin simbolo o timeframe no abre nada', () => {
    renderHook(() => useLiveCandles(undefined, '1m', { ctor: FakeEventSource }));
    renderHook(() => useLiveCandles('BTCUSDT', undefined, { ctor: FakeEventSource }));

    expect(FakeEventSource.openCount).toBe(0);
  });

  it('cambiar de serie cierra el stream anterior y limpia el estado', async () => {
    const { result, rerender } = renderHook(
      ({ timeframe }: { timeframe: '1m' | '15m' }) =>
        useLiveCandles('BTCUSDT', timeframe, { ctor: FakeEventSource }),
      { initialProps: { timeframe: '1m' } },
    );

    const first = FakeEventSource.last();
    act(() => {
      first.emit('candle', tick({ closed: true, c: 104 }));
    });
    await waitFor(() => {
      expect(result.current.lastClosed?.c).toBe(104);
    });

    rerender({ timeframe: '15m' });

    expect(first.closeCalls).toBe(1);
    expect(result.current.lastClosed).toBeUndefined();
    expect(FakeEventSource.last().url).toContain('timeframe=15m');
  });

  it('desmontar cierra el stream', () => {
    const { unmount } = renderHook(() =>
      useLiveCandles('BTCUSDT', '1m', { ctor: FakeEventSource }),
    );

    const connection = FakeEventSource.last();
    unmount();

    expect(connection.closeCalls).toBe(1);
  });
});
