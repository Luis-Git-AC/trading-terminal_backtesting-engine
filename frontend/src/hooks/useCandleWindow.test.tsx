import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { waitFor } from '@testing-library/react';
import { useCandleWindow } from '@/hooks/useCandleWindow';
import * as fixtures from '@/test/msw/fixtures';
import { API_BASE } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { renderHookWithQuery } from '@/test/query-wrapper';

function emptyCoverage(): void {
  server.use(
    http.get(`${API_BASE}/api/markets/:exchange/:symbol/coverage`, ({ params, request }) => {
      const timeframe = new URL(request.url).searchParams.get('timeframe');
      return HttpResponse.json({
        ...fixtures.coverage,
        symbol: String(params.symbol),
        timeframe: timeframe ?? '1m',
        from: null,
        to: null,
        candles: 0,
        expected: 0,
        missing: 0,
        gaps: [],
        backfill: { done: false, cursor: null },
      });
    }),
  );
}

describe('useCandleWindow', () => {
  it('ancla la ventana en el ultimo dato de la cobertura', async () => {
    const { result } = renderHookWithQuery(() => useCandleWindow('binance', 'BTCUSDT', '15m'));

    await waitFor(() => {
      expect(result.current.isPending).toBe(false);
    });

    expect(result.current.candles.length).toBeGreaterThan(0);
    expect(result.current.error).toBeNull();
  });

  it('una serie sin velas deja de cargar en vez de quedarse pendiente para siempre', async () => {
    emptyCoverage();

    const { result } = renderHookWithQuery(() => useCandleWindow('binance', 'SOLUSDT', '1m'));

    await waitFor(() => {
      expect(result.current.isPending).toBe(false);
    });

    expect(result.current.candles).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('una serie sin velas no pide velas al API', async () => {
    emptyCoverage();
    let requests = 0;
    server.use(
      http.get(`${API_BASE}/api/candles`, () => {
        requests += 1;
        return HttpResponse.json(fixtures.candles);
      }),
    );

    const { result } = renderHookWithQuery(() => useCandleWindow('binance', 'SOLUSDT', '1m'));

    await waitFor(() => {
      expect(result.current.isPending).toBe(false);
    });

    expect(requests).toBe(0);
  });

  it('sin simbolo ni timeframe tampoco se queda pendiente', async () => {
    const { result } = renderHookWithQuery(() => useCandleWindow('binance', undefined, undefined));

    await waitFor(() => {
      expect(result.current.isPending).toBe(false);
    });

    expect(result.current.candles).toEqual([]);
  });
});
