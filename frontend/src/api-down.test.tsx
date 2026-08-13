import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App } from '@/App';
import { ApiError } from '@/api/errors';
import { MAX_QUERY_RETRIES, shouldRetry } from '@/api/query-client';
import { API_BASE } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { silentQueryClient } from '@/test/query-wrapper';

vi.mock('lightweight-charts', () => import('@/test/fake-lightweight-charts'));

function renderApp(path = '/') {
  return render(
    <QueryClientProvider client={silentQueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function killTheApi(): { count: () => number } {
  let calls = 0;

  server.use(
    http.get(`${API_BASE}/api/*`, () => {
      calls += 1;
      return HttpResponse.error();
    }),
  );

  return { count: () => calls };
}

describe('politica de reintentos', () => {
  it('no reintenta indefinidamente: hay un tope de intentos', () => {
    const network = ApiError.network(new TypeError('fetch failed'));

    expect(shouldRetry(0, network)).toBe(true);
    expect(shouldRetry(MAX_QUERY_RETRIES - 1, network)).toBe(true);
    expect(shouldRetry(MAX_QUERY_RETRIES, network)).toBe(false);
    expect(shouldRetry(MAX_QUERY_RETRIES + 1, network)).toBe(false);
  });

  it('un fallo del cliente no se reintenta ni una vez: repetirlo daria lo mismo', () => {
    expect(shouldRetry(0, new ApiError('VALIDATION_ERROR', 'mal', { status: 400 }))).toBe(false);
    expect(shouldRetry(0, new ApiError('NOT_FOUND', 'no esta', { status: 404 }))).toBe(false);
    expect(shouldRetry(0, new ApiError('CONFLICT', 'ya corre', { status: 409 }))).toBe(false);
  });

  it('un 5xx si se reintenta, porque puede ser transitorio', () => {
    expect(shouldRetry(0, new ApiError('INTERNAL', 'boom', { status: 500 }))).toBe(true);
    expect(shouldRetry(0, new ApiError('UPSTREAM_UNAVAILABLE', 'x', { status: 503 }))).toBe(true);
  });

  it('lo que no es un ApiError no se reintenta: no sabemos si es seguro', () => {
    expect(shouldRetry(0, new Error('vete a saber'))).toBe(false);
  });
});

describe('con el API caido', () => {
  it('la terminal explica el fallo en cada panel en vez de quedarse en blanco', async () => {
    killTheApi();
    renderApp('/');

    await waitFor(() => {
      expect(screen.getAllByRole('alert').length).toBeGreaterThanOrEqual(2);
    });

    const alerts = screen.getAllByRole('alert');
    const texts = alerts.map((alert) => alert.textContent ?? '');

    expect(texts.some((text) => text.includes('catalogo de estrategias'))).toBe(true);
    expect(texts.some((text) => text.includes('las velas'))).toBe(true);

    for (const text of texts) {
      expect(text).toContain('No se ha podido contactar con el API.');
      expect(text).toContain('npm run dev:api');
    }
  });

  it('la cabecera deja de decir «En vivo» y pasa a «Sin conexion»', async () => {
    killTheApi();
    renderApp('/');

    const header = screen.getByRole('banner');
    await waitFor(() => {
      expect(within(header).getByText('Sin conexion')).toBeDefined();
    });
    expect(within(header).queryByText('En vivo')).toBeNull();
  });

  it('el historial tambien lo dice, con boton para reintentar a mano', async () => {
    killTheApi();
    renderApp('/runs');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('No se ha podido cargar el historial');
    expect(within(alert).getByRole('button', { name: 'Reintentar' })).toBeDefined();
  });

  it('el fallo no dispara una tanda ilimitada de peticiones', async () => {
    const api = killTheApi();
    renderApp('/');

    await waitFor(() => {
      expect(screen.getAllByRole('alert').length).toBeGreaterThanOrEqual(2);
    });

    const settled = api.count();
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(api.count()).toBe(settled);
    expect(settled).toBeLessThanOrEqual(10);
  });
});
