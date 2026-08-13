import { StrictMode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@/App';
import { DEFAULT_SYMBOL, DEFAULT_TIMEFRAME } from '@/state/market-selection';
import * as fixtures from '@/test/msw/fixtures';
import { API_BASE } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { silentQueryClient } from '@/test/query-wrapper';

const consoleCalls: unknown[][] = [];

function renderAt(path: string) {
  return render(
    <StrictMode>
      <QueryClientProvider client={silentQueryClient()}>
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>
    </StrictMode>,
  );
}

describe('App', () => {
  beforeEach(() => {
    consoleCalls.length = 0;
    const record = (...args: unknown[]) => {
      consoleCalls.push(args);
    };
    vi.spyOn(console, 'error').mockImplementation(record);
    vi.spyOn(console, 'warn').mockImplementation(record);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    expect(consoleCalls).toEqual([]);
  });

  it('pinta la cabecera con marca, navegacion y estado de conexion', () => {
    renderAt('/');

    const header = screen.getByRole('banner');
    expect(within(header).getByText('Trading Terminal')).toBeDefined();
    expect(within(header).getByRole('link', { name: 'Terminal' })).toBeDefined();
    expect(within(header).getByRole('link', { name: 'Runs' })).toBeDefined();
    expect(within(header).getByText('Sin conexion')).toBeDefined();
  });

  it('el selector solo ofrece los simbolos que sirve el API', async () => {
    renderAt('/');

    const symbol = screen.getByRole('combobox', { name: /simbolo/i });

    await waitFor(() => {
      expect(
        within(symbol)
          .getAllByRole('option')
          .map((option) => option.textContent),
      ).toEqual(fixtures.markets.symbols.map((market) => market.symbol));
    });
    expect(symbol).toHaveProperty('value', DEFAULT_SYMBOL);

    const active = screen.getByRole('button', { name: DEFAULT_TIMEFRAME });
    expect(active.getAttribute('aria-pressed')).toBe('true');
  });

  it('si el API no sirve el simbolo por defecto, selecciona el primero que si sirve', async () => {
    server.use(
      http.get(`${API_BASE}/api/markets`, () =>
        HttpResponse.json({
          exchange: 'bitget',
          symbols: [
            { symbol: 'SOLUSDT', timeframes: ['1m', '1h'], pricePrecision: 2, qtyPrecision: 2 },
          ],
        }),
      ),
    );

    renderAt('/');

    const symbol = screen.getByRole('combobox', { name: /simbolo/i });
    await waitFor(() => {
      expect(symbol).toHaveProperty('value', 'SOLUSDT');
    });
    expect(within(symbol).getAllByRole('option')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: '15m' })).toBeNull();
  });

  it('la ruta raiz muestra las tres zonas de la terminal', () => {
    renderAt('/');

    expect(screen.getByRole('heading', { name: 'Parametros' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Grafico' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Resultados' })).toBeDefined();
  });

  it('la ruta /runs muestra el historial y no la terminal', () => {
    renderAt('/runs');

    expect(screen.getByRole('heading', { name: 'Historial de runs' })).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'Parametros' })).toBeNull();
  });

  it('declara que por debajo de 960 px no hay soporte', () => {
    renderAt('/');

    expect(screen.getByText(/no se da\s+soporte/i)).toBeDefined();
  });

  it('monta las dos rutas seguidas sin ensuciar la consola', () => {
    renderAt('/');
    renderAt('/runs');

    expect(consoleCalls).toEqual([]);
  });
});
