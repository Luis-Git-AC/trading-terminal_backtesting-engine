import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { waitFor } from '@testing-library/react';
import { useRun, useRunEquity, useRunTrades, useRuns } from '@/hooks/useRuns';
import * as fixtures from '@/test/msw/fixtures';
import { API_BASE } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { renderHookWithQuery, waitForSuccess } from '@/test/query-wrapper';

describe('useRuns', () => {
  it('lista los runs y pasa loading -> success', async () => {
    const { result } = renderHookWithQuery(() => useRuns());

    expect(result.current.isPending).toBe(true);

    await waitForSuccess(result);

    expect(result.current.data?.runs).toHaveLength(2);
  });

  it('manda los filtros de estado y limite en la query', async () => {
    const seen: string[] = [];
    server.use(
      http.get(`${API_BASE}/api/backtests`, ({ request }) => {
        seen.push(new URL(request.url).search);
        return HttpResponse.json(fixtures.runs);
      }),
    );

    const { result } = renderHookWithQuery(() => useRuns({ status: 'completed', limit: 10 }));
    await waitForSuccess(result);

    expect(seen[0]).toContain('status=completed');
    expect(seen[0]).toContain('limit=10');
  });
});

describe('useRun', () => {
  it('sin runId no pide nada', async () => {
    const { result } = renderHookWithQuery(() => useRun(undefined));

    await waitFor(() => {
      expect(result.current.fetchStatus).toBe('idle');
    });
    expect(result.current.isPending).toBe(true);
  });

  it('devuelve el detalle del run, con params y exec', async () => {
    const { result } = renderHookWithQuery(() => useRun(fixtures.RUN_ID));

    await waitForSuccess(result);

    expect(result.current.data?.id).toBe(fixtures.RUN_ID);
    expect(result.current.data?.params).toEqual({
      fastPeriod: 12,
      slowPeriod: 26,
      allowShort: true,
    });
    expect(result.current.data?.exec.initialCapital).toBe(10_000);
  });

  it('un run inexistente da ApiError NOT_FOUND', async () => {
    const { result } = renderHookWithQuery(() => useRun('00000000-0000-4000-8000-000000000000'));

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error!.code).toBe('NOT_FOUND');
  });
});

describe('useRunTrades', () => {
  it('devuelve los trades del run', async () => {
    const { result } = renderHookWithQuery(() => useRunTrades({ runId: fixtures.RUN_ID }));

    await waitForSuccess(result);

    expect(result.current.data?.trades).toHaveLength(1);
    expect(result.current.data?.trades[0]?.exitReason).toBe('take-profit');
  });

  it('sin request no pide nada', async () => {
    const { result } = renderHookWithQuery(() => useRunTrades(undefined));

    await waitFor(() => {
      expect(result.current.fetchStatus).toBe('idle');
    });
  });
});

describe('useRunEquity', () => {
  it('devuelve la curva de equity', async () => {
    const { result } = renderHookWithQuery(() => useRunEquity(fixtures.RUN_ID));

    await waitForSuccess(result);

    expect(result.current.data?.points).toHaveLength(2);
    expect(result.current.data?.points[0]?.dd).toBe(0);
  });
});
