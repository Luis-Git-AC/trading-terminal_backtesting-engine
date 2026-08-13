import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { waitFor } from '@testing-library/react';
import type { ApiError } from '@/api/errors';
import { useCandles } from '@/hooks/useCandles';
import { useStrategies } from '@/hooks/useStrategies';
import * as fixtures from '@/test/msw/fixtures';
import { API_BASE, errorResponse } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { renderHookWithQuery, waitForSuccess } from '@/test/query-wrapper';

const REQUEST = { symbol: 'BTCUSDT', timeframe: '15m', from: 1_785_000_000_000 } as const;

describe('useCandles', () => {
  it('pasa loading -> success con las velas del contrato', async () => {
    const { result } = renderHookWithQuery(() => useCandles(REQUEST));

    expect(result.current.isPending).toBe(true);

    await waitForSuccess(result);

    expect(result.current.data?.candles).toHaveLength(3);
    expect(result.current.data?.nextFrom).toBe(1_785_002_700_000);
  });

  it('sin request no pide nada', async () => {
    const { result } = renderHookWithQuery(() => useCandles(undefined));

    await waitFor(() => {
      expect(result.current.fetchStatus).toBe('idle');
    });
    expect(result.current.isPending).toBe(true);
  });

  it('manda simbolo, timeframe, from, to y limit en la query', async () => {
    const seen: string[] = [];
    server.use(
      http.get(`${API_BASE}/api/candles`, ({ request }) => {
        seen.push(new URL(request.url).search);
        return HttpResponse.json(fixtures.candles);
      }),
    );

    const { result } = renderHookWithQuery(() =>
      useCandles({ ...REQUEST, to: 1_785_009_000_000, limit: 500 }),
    );
    await waitForSuccess(result);

    expect(seen[0]).toContain('symbol=BTCUSDT');
    expect(seen[0]).toContain('timeframe=15m');
    expect(seen[0]).toContain('from=1785000000000');
    expect(seen[0]).toContain('to=1785009000000');
    expect(seen[0]).toContain('limit=500');
  });

  it('un rango demasiado grande llega como RANGE_TOO_LARGE', async () => {
    server.use(
      http.get(`${API_BASE}/api/candles`, () =>
        errorResponse('RANGE_TOO_LARGE', 'limit no puede superar 5000'),
      ),
    );

    const { result } = renderHookWithQuery(() => useCandles(REQUEST));

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    const error = result.current.error as ApiError;
    expect(error.code).toBe('RANGE_TOO_LARGE');
    expect(error.status).toBe(413);
  });
});

describe('useStrategies', () => {
  it('devuelve el catalogo con sus parametros', async () => {
    const { result } = renderHookWithQuery(() => useStrategies());

    await waitForSuccess(result);

    expect(result.current.data?.strategies[0]?.id).toBe('ema-cross');
    expect(result.current.data?.strategies[0]?.params).toHaveLength(3);
  });

  it('si el catalogo cae, el hook expone el error en vez de datos vacios', async () => {
    server.use(
      http.get(`${API_BASE}/api/strategies`, () => errorResponse('INTERNAL', 'Se rompio algo')),
    );

    const { result } = renderHookWithQuery(() => useStrategies());

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.data).toBeUndefined();
    expect((result.current.error as ApiError).code).toBe('INTERNAL');
  });
});
