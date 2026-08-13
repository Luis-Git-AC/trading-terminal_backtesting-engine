import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { apiClient, buildUrl, createApiClient, resolveBaseUrl } from '@/api/client';
import { ApiError } from '@/api/errors';
import { API_BASE, errorResponse } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { http, HttpResponse } from 'msw';
import * as fixtures from '@/test/msw/fixtures';
import { marketsResponseSchema } from '@tt/shared';

function client() {
  return createApiClient({ baseUrl: API_BASE, validate: true });
}

describe('resolveBaseUrl', () => {
  it('deja la url tal cual si no acaba en barra', () => {
    expect(resolveBaseUrl('http://api.test')).toBe('http://api.test');
  });

  it('quita la barra final para no generar dobles barras', () => {
    expect(resolveBaseUrl('http://api.test/')).toBe('http://api.test');
  });

  it('sin VITE_API_URL cae a rutas relativas', () => {
    expect(resolveBaseUrl(undefined)).toBe('');
    expect(buildUrl(resolveBaseUrl(undefined), '/markets', undefined)).toBe('/api/markets');
  });
});

describe('buildUrl', () => {
  it('antepone /api a la ruta del recurso', () => {
    expect(buildUrl(API_BASE, '/markets', undefined)).toBe(`${API_BASE}/api/markets`);
  });

  it('serializa la query y omite los undefined', () => {
    const url = buildUrl(API_BASE, '/candles', {
      symbol: 'BTCUSDT',
      timeframe: '15m',
      from: 1000,
      to: undefined,
    });

    expect(url).toBe(`${API_BASE}/api/candles?symbol=BTCUSDT&timeframe=15m&from=1000`);
  });

  it('escapa los valores de la query', () => {
    expect(buildUrl(API_BASE, '/backtests/compare', { ids: 'a,b' })).toBe(
      `${API_BASE}/api/backtests/compare?ids=a%2Cb`,
    );
  });
});

describe('createApiClient', () => {
  it('el cliente por defecto toma VITE_API_URL', () => {
    expect(apiClient.baseUrl).toBe(resolveBaseUrl(import.meta.env.VITE_API_URL));
  });

  it('devuelve la respuesta parseada por el esquema compartido', async () => {
    const result = await client().request({
      path: '/markets',
      schema: marketsResponseSchema,
    });

    expect(result).toEqual(fixtures.markets);
  });

  it('manda el cuerpo como JSON en un POST', async () => {
    const seen: unknown[] = [];
    server.use(
      http.post(`${API_BASE}/api/echo`, async ({ request }) => {
        seen.push(await request.json());
        return HttpResponse.json({ ok: true });
      }),
    );

    await client().request({
      path: '/echo',
      method: 'POST',
      body: { hello: 'mundo' },
      schema: z.object({ ok: z.boolean() }),
    });

    expect(seen).toEqual([{ hello: 'mundo' }]);
  });

  it('requestVoid acepta un 204 sin cuerpo', async () => {
    await expect(
      client().requestVoid({ path: `/backtests/${fixtures.RUN_ID}`, method: 'DELETE' }),
    ).resolves.toBeUndefined();
  });
});

describe('errores del API', () => {
  it('convierte el sobre del contrato en ApiError con code, status y detalles', async () => {
    server.use(
      http.get(`${API_BASE}/api/markets`, () =>
        errorResponse('VALIDATION_ERROR', 'timeframe invalido', [
          { path: 'timeframe', message: 'Invalid enum value' },
        ]),
      ),
    );

    const error = await client()
      .request({ path: '/markets', schema: marketsResponseSchema })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.code).toBe('VALIDATION_ERROR');
    expect(apiError.status).toBe(400);
    expect(apiError.message).toBe('timeframe invalido');
    expect(apiError.details).toEqual([{ path: 'timeframe', message: 'Invalid enum value' }]);
    expect(apiError.isTransport).toBe(false);
  });

  it('un 404 llega como NOT_FOUND legible', async () => {
    const error = await client()
      .request({ path: '/backtests/00000000-0000-4000-8000-000000000000', schema: z.unknown() })
      .catch((caught: unknown) => caught);

    expect((error as ApiError).code).toBe('NOT_FOUND');
    expect((error as ApiError).message).toContain('No existe el run');
  });

  it('un cuerpo de error que no cumple el sobre cae al code derivado del status', async () => {
    server.use(
      http.get(`${API_BASE}/api/markets`, () => HttpResponse.json({ oops: true }, { status: 409 })),
    );

    const error = await client()
      .request({ path: '/markets', schema: marketsResponseSchema })
      .catch((caught: unknown) => caught);

    expect((error as ApiError).code).toBe('CONFLICT');
    expect((error as ApiError).message).toContain('HTTP 409');
  });

  it('un fallo de red da NETWORK_ERROR, no un TypeError suelto', async () => {
    server.use(http.get(`${API_BASE}/api/markets`, () => HttpResponse.error()));

    const error = await client()
      .request({ path: '/markets', schema: marketsResponseSchema })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('NETWORK_ERROR');
    expect((error as ApiError).isTransport).toBe(true);
    expect((error as ApiError).status).toBeNull();
  });

  it('un 200 que no es JSON da MALFORMED_RESPONSE', async () => {
    server.use(http.get(`${API_BASE}/api/markets`, () => HttpResponse.text('<html>nope</html>')));

    const error = await client()
      .request({ path: '/markets', schema: marketsResponseSchema })
      .catch((caught: unknown) => caught);

    expect((error as ApiError).code).toBe('MALFORMED_RESPONSE');
  });

  it('una respuesta que no cumple el esquema compartido falla nombrando el campo', async () => {
    server.use(
      http.get(`${API_BASE}/api/markets`, () =>
        HttpResponse.json({ exchange: 'bitget', symbols: [{ symbol: 'BTCUSDT' }] }),
      ),
    );

    const error = await client()
      .request({ path: '/markets', schema: marketsResponseSchema })
      .catch((caught: unknown) => caught);

    expect((error as ApiError).code).toBe('MALFORMED_RESPONSE');
    expect((error as ApiError).message).toContain('/markets');
    expect((error as ApiError).message).toContain('timeframes');
  });

  it('con validate:false la respuesta pasa sin comprobar el contrato', async () => {
    server.use(
      http.get(`${API_BASE}/api/markets`, () => HttpResponse.json({ exchange: 'bitget' })),
    );

    const relaxed = createApiClient({ baseUrl: API_BASE, validate: false });

    await expect(
      relaxed.request({ path: '/markets', schema: marketsResponseSchema }),
    ).resolves.toEqual({ exchange: 'bitget' });
  });

  it('un abort se propaga tal cual, no como ApiError', async () => {
    const controller = new AbortController();
    controller.abort();

    const error = await client()
      .request({ path: '/markets', schema: marketsResponseSchema, signal: controller.signal })
      .catch((caught: unknown) => caught);

    expect(error).not.toBeInstanceOf(ApiError);
  });

  it('propaga la señal de aborto al fetch inyectado', async () => {
    const spy = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(HttpResponse.json(fixtures.markets)),
    );
    const controller = new AbortController();

    await createApiClient({ baseUrl: API_BASE, validate: true, fetch: spy }).request({
      path: '/markets',
      schema: marketsResponseSchema,
      signal: controller.signal,
    });

    expect(spy.mock.calls[0]?.[1]).toMatchObject({ signal: controller.signal });
  });
});
