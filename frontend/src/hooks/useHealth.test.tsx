import { waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { useHealth } from '@/hooks/useHealth';
import * as fixtures from '@/test/msw/fixtures';
import { API_BASE, errorResponse } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { renderHookWithQuery, waitForSuccess } from '@/test/query-wrapper';

describe('useHealth', () => {
  it('devuelve la salud validada contra el esquema compartido', async () => {
    const { result } = renderHookWithQuery(() => useHealth());

    await waitForSuccess(result);
    expect(result.current.data).toEqual(fixtures.health);
  });

  it('el bloque de ingesta puede no venir y la query sigue en verde', async () => {
    server.use(
      http.get(`${API_BASE}/api/health`, () =>
        HttpResponse.json({ ...fixtures.health, checks: { db: 'ok', redis: 'ok' } }),
      ),
    );

    const { result } = renderHookWithQuery(() => useHealth());

    await waitForSuccess(result);
    expect(result.current.data?.checks.ingest).toBeUndefined();
  });

  it('con el API caido queda en error con un ApiError, no colgada en loading', async () => {
    server.use(http.get(`${API_BASE}/api/health`, () => errorResponse('INTERNAL', 'todo mal')));

    const { result } = renderHookWithQuery(() => useHealth());

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error?.code).toBe('INTERNAL');
    expect(result.current.isPending).toBe(false);
  });
});
