import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { waitFor } from '@testing-library/react';
import type { ApiError } from '@/api/errors';
import { useCoverage, useMarkets } from '@/hooks/useMarkets';
import * as fixtures from '@/test/msw/fixtures';
import { API_BASE, errorResponse } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { renderHookWithQuery, waitForSuccess } from '@/test/query-wrapper';

describe('useMarkets', () => {
  it('empieza en loading y termina en success con los datos del contrato', async () => {
    const { result } = renderHookWithQuery(() => useMarkets());

    expect(result.current.isPending).toBe(true);
    expect(result.current.data).toBeUndefined();

    await waitForSuccess(result);

    expect(result.current.data).toEqual(fixtures.markets);
  });

  it('un error del API llega como ApiError con code, no como pantalla en blanco', async () => {
    server.use(
      http.get(`${API_BASE}/api/markets`, () =>
        errorResponse('UPSTREAM_UNAVAILABLE', 'El exchange no responde'),
      ),
    );

    const { result } = renderHookWithQuery(() => useMarkets());

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    const error = result.current.error as ApiError;
    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(error.message).toBe('El exchange no responde');
  });
});

describe('useCoverage', () => {
  it('no lanza la peticion mientras falte simbolo o timeframe', async () => {
    let requests = 0;
    server.use(
      http.get(`${API_BASE}/api/markets/:symbol/coverage`, () => {
        requests += 1;
        return HttpResponse.json(fixtures.coverage);
      }),
    );

    const { result } = renderHookWithQuery(() => useCoverage(undefined, '15m'));

    await waitFor(() => {
      expect(result.current.fetchStatus).toBe('idle');
    });
    expect(result.current.isPending).toBe(true);
    expect(requests).toBe(0);
  });

  it('pide la cobertura del simbolo y timeframe seleccionados', async () => {
    const { result } = renderHookWithQuery(() => useCoverage('ETHUSDT', '1h'));

    await waitForSuccess(result);

    expect(result.current.data?.symbol).toBe('ETHUSDT');
    expect(result.current.data?.timeframe).toBe('1h');
  });

  it('cachea por simbolo y timeframe: cambiar de timeframe refetchea', async () => {
    const seen: string[] = [];
    server.use(
      http.get(`${API_BASE}/api/markets/:symbol/coverage`, ({ request }) => {
        const timeframe = new URL(request.url).searchParams.get('timeframe') ?? '';
        seen.push(timeframe);
        return HttpResponse.json({ ...fixtures.coverage, timeframe });
      }),
    );

    const { result, rerender } = renderHookWithQuery(
      ({ timeframe }: { timeframe: '15m' | '1h' }) => useCoverage('BTCUSDT', timeframe),
      undefined,
      { timeframe: '15m' },
    );

    await waitForSuccess(result);
    rerender({ timeframe: '1h' });
    await waitFor(() => {
      expect(result.current.data?.timeframe).toBe('1h');
    });

    expect(seen).toEqual(['15m', '1h']);
  });
});
