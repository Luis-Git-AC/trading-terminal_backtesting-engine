import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('lightweight-charts', () => import('@/test/fake-lightweight-charts'));

const { Terminal, RUN_PARAM } = await import('@/pages/Terminal');
const { MarketSelectionProvider } = await import('@/state/market-selection');
const fake = await import('@/test/fake-lightweight-charts');
const { FakeEventSource } = await import('@/test/fake-event-source');
const fixtures = await import('@/test/msw/fixtures');
const { API_BASE } = await import('@/test/msw/handlers');
const { server } = await import('@/test/msw/server');
const { silentQueryClient } = await import('@/test/query-wrapper');

beforeEach(() => {
  fake.resetFakeCharts();
  FakeEventSource.reset();
  globalThis.EventSource ??= FakeEventSource as unknown as typeof globalThis.EventSource;
});

function renderTerminal(initialPath = '/') {
  return render(
    <QueryClientProvider client={silentQueryClient()}>
      <MemoryRouter initialEntries={[initialPath]}>
        <MarketSelectionProvider>
          <Terminal />
        </MarketSelectionProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Terminal', () => {
  it('sin run en la URL no abre ningun stream de progreso', async () => {
    renderTerminal();

    await waitFor(() => {
      expect(screen.getByText(/para lanzar un run/i)).toBeDefined();
    });
    expect(
      FakeEventSource.instances.filter((source) => source.url.includes('/stream')).length,
    ).toBe(0);
  });

  it('con un run en la URL reengancha el SSE de ese run al cargar', async () => {
    renderTerminal(`/?${RUN_PARAM}=${fixtures.RUN_ID}`);

    await waitFor(() => {
      expect(
        FakeEventSource.instances.some((source) =>
          source.url.includes(`/api/backtests/${fixtures.RUN_ID}/stream`),
        ),
      ).toBe(true);
    });
  });

  it('lanzar un backtest deja el runId en la URL', async () => {
    renderTerminal();

    const submit = await screen.findByRole('button', { name: /ejecutar backtest/i });
    await waitFor(() => {
      expect(submit).toHaveProperty('disabled', false);
    });

    act(() => {
      submit.click();
    });

    await waitFor(() => {
      expect(
        FakeEventSource.instances.some((source) =>
          source.url.includes(`/api/backtests/${fixtures.RUN_ID}/stream`),
        ),
      ).toBe(true);
    });
  });

  it('al completarse un run, sus trades se pintan como marcadores en el chart', async () => {
    server.use(
      http.get(`${API_BASE}/api/backtests/:id`, () =>
        HttpResponse.json({ ...fixtures.run, symbol: 'BTCUSDT', timeframe: '15m' }),
      ),
    );

    renderTerminal(`/?${RUN_PARAM}=${fixtures.RUN_ID}`);

    await waitFor(() => {
      expect(fake.markerPlugins.length).toBeGreaterThan(0);
    });

    await waitFor(() => {
      const markers = fake.lastMarkers().setMarkersCalls.at(-1) ?? [];
      expect(markers).toHaveLength(fixtures.trades.trades.length * 2);
    });
  });

  it('un run de otra serie no ensucia el chart con sus marcadores', async () => {
    server.use(
      http.get(`${API_BASE}/api/backtests/:id`, () =>
        HttpResponse.json({ ...fixtures.run, symbol: 'ETHUSDT', timeframe: '1h' }),
      ),
    );

    renderTerminal(`/?${RUN_PARAM}=${fixtures.RUN_ID}`);

    await waitFor(() => {
      expect(fake.markerPlugins.length).toBeGreaterThan(0);
    });
    await waitFor(() => {
      expect(screen.getByText('Completado')).toBeDefined();
    });

    expect(fake.lastMarkers().setMarkersCalls.at(-1)).toEqual([]);
  });
});
