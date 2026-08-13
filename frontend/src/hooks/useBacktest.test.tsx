import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { waitFor } from '@testing-library/react';
import type { CreateBacktestBody } from '@tt/shared';
import { queryKeys } from '@/api/query-keys';
import { useCancelBacktest, useCreateBacktest, useDeleteBacktest } from '@/hooks/useBacktest';
import { useRuns } from '@/hooks/useRuns';
import * as fixtures from '@/test/msw/fixtures';
import { API_BASE, errorResponse } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { renderHookWithQuery, silentQueryClient, waitForSuccess } from '@/test/query-wrapper';

const BODY: CreateBacktestBody = {
  symbol: 'BTCUSDT',
  timeframe: '15m',
  from: Date.parse('2026-01-01T00:00:00.000Z'),
  to: Date.parse('2026-06-30T23:59:59.000Z'),
  strategyId: 'ema-cross',
  params: { fastPeriod: 12, slowPeriod: 26 },
  exec: {
    initialCapital: 10_000,
    riskPerTradePct: 1,
    feeBps: 6,
    slippageBps: 2,
    fillModel: 'next-open',
  },
  seed: 42,
};

describe('useCreateBacktest', () => {
  it('devuelve runId, seed y paramsHash del 202', async () => {
    const { result } = renderHookWithQuery(() => useCreateBacktest());

    result.current.mutate(BODY);

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(fixtures.created);
  });

  it('manda el cuerpo tal cual, con el seed que se le pasa', async () => {
    const seen: unknown[] = [];
    server.use(
      http.post(`${API_BASE}/api/backtests`, async ({ request }) => {
        seen.push(await request.json());
        return HttpResponse.json(fixtures.created, { status: 202 });
      }),
    );

    const { result } = renderHookWithQuery(() => useCreateBacktest());
    result.current.mutate(BODY);

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(seen).toEqual([BODY]);
  });

  it('invalida la lista de runs al completarse', async () => {
    const queryClient = silentQueryClient();

    const runs = renderHookWithQuery(() => useRuns(), queryClient);
    await waitForSuccess(runs.result);

    const before = queryClient.getQueryState(queryKeys.runList({}))?.dataUpdatedAt ?? 0;

    const mutation = renderHookWithQuery(() => useCreateBacktest(), queryClient);
    mutation.result.current.mutate(BODY);

    await waitFor(() => {
      expect(mutation.result.current.isSuccess).toBe(true);
    });

    await waitFor(() => {
      const after = queryClient.getQueryState(queryKeys.runList({}))?.dataUpdatedAt ?? 0;
      expect(after).toBeGreaterThan(before);
    });
  });

  it('un 400 del servidor llega como ApiError con los detalles de validacion', async () => {
    server.use(
      http.post(`${API_BASE}/api/backtests`, () =>
        errorResponse('VALIDATION_ERROR', 'La peticion no cumple el contrato', [
          { path: 'body.exec', message: 'Required' },
        ]),
      ),
    );

    const { result } = renderHookWithQuery(() => useCreateBacktest());
    result.current.mutate(BODY);

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    const error = result.current.error!;
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.details).toEqual([{ path: 'body.exec', message: 'Required' }]);
  });
});

describe('useCancelBacktest', () => {
  it('cancela y devuelve el estado que responde el servidor', async () => {
    const { result } = renderHookWithQuery(() => useCancelBacktest());

    result.current.mutate(fixtures.RUN_ID);

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual({ runId: fixtures.RUN_ID, status: 'cancelled' });
  });

  it('cancelar un run ya terminado da CONFLICT', async () => {
    server.use(
      http.post(`${API_BASE}/api/backtests/:id/cancel`, () =>
        errorResponse('CONFLICT', 'El run ya ha terminado'),
      ),
    );

    const { result } = renderHookWithQuery(() => useCancelBacktest());
    result.current.mutate(fixtures.RUN_ID);

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error!.code).toBe('CONFLICT');
    expect(result.current.error!.status).toBe(409);
  });
});

describe('useDeleteBacktest', () => {
  it('borra el run y saca su detalle de la cache', async () => {
    const queryClient = silentQueryClient();

    const detail = renderHookWithQuery(() => useRuns(), queryClient);
    await waitForSuccess(detail.result);

    queryClient.setQueryData(queryKeys.run(fixtures.RUN_ID), fixtures.run);

    const mutation = renderHookWithQuery(() => useDeleteBacktest(), queryClient);
    mutation.result.current.mutate(fixtures.RUN_ID);

    await waitFor(() => {
      expect(mutation.result.current.isSuccess).toBe(true);
    });

    expect(queryClient.getQueryData(queryKeys.run(fixtures.RUN_ID))).toBeUndefined();
  });
});
