import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DerivativesPanel, mergeSeries } from '@/components/Chart/DerivativesPanel';
import { groupByAssetClass } from '@/components/AppShell/AppHeader';
import * as fixtures from '@/test/msw/fixtures';
import { errorResponse, handlers, API_BASE } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { silentQueryClient } from '@/test/query-wrapper';
import { http, HttpResponse } from 'msw';

const FROM = 1_785_000_000_000;
const TO = FROM + 12 * 3_600_000;

function renderPanel(symbol = 'BTCUSDT') {
  return render(
    <QueryClientProvider client={silentQueryClient()}>
      <DerivativesPanel exchange="binance" symbol={symbol} from={FROM} to={TO} />
    </QueryClientProvider>,
  );
}

describe('mezcla de funding y open interest', () => {
  it('ordena por timestamp y deja huecos en la serie que no tiene punto', () => {
    const merged = mergeSeries(fixtures.funding.funding, fixtures.openInterest.openInterest);

    expect(merged.map((point) => point.t)).toEqual([
      1_785_000_000_000, 1_785_003_600_000, 1_785_028_800_000,
    ]);
    expect(merged[0]).toEqual({ t: 1_785_000_000_000, ratePct: 0.01, oi: 81_234.5 });
    expect(merged[1]?.ratePct).toBeNull();
    expect(merged[2]?.oi).toBeNull();
  });

  it('una serie vacia no inventa puntos', () => {
    expect(mergeSeries([], [])).toEqual([]);
  });
});

describe('panel de funding y OI', () => {
  it('pinta el grafico de la serie seleccionada', async () => {
    renderPanel();

    await waitFor(() => {
      expect(screen.getByTestId('derivatives-chart')).toBeDefined();
    });
  });

  it('sin datos muestra un estado explicito, no un grafico en blanco', async () => {
    server.use(
      http.get(`${API_BASE}/api/derivatives/:exchange/:symbol/funding`, () =>
        HttpResponse.json({ ...fixtures.funding, count: 0, funding: [], nextFrom: null }),
      ),
      http.get(`${API_BASE}/api/derivatives/:exchange/:symbol/open-interest`, () =>
        HttpResponse.json({ ...fixtures.openInterest, count: 0, openInterest: [], nextFrom: null }),
      ),
    );

    renderPanel('XAUUSDT');

    await waitFor(() => {
      expect(screen.getByText(/Sin funding ni open interest de XAUUSDT/)).toBeDefined();
    });
    expect(screen.queryByTestId('derivatives-chart')).toBeNull();
  });

  it('un error del API se cuenta con opcion de reintento', async () => {
    server.use(
      http.get(`${API_BASE}/api/derivatives/:exchange/:symbol/funding`, () =>
        errorResponse('INTERNAL', 'se cayo'),
      ),
    );

    renderPanel();

    await waitFor(() => {
      expect(screen.getByText(/No se han podido cargar funding y OI/)).toBeDefined();
    });
    expect(screen.getByRole('button', { name: /reintentar/i })).toBeDefined();
  });

  it('los handlers por defecto siguen sirviendo las dos series', () => {
    expect(handlers.length).toBeGreaterThan(0);
  });
});

describe('agrupacion del selector de mercado', () => {
  it('separa crypto, metales y energia y omite los grupos vacios', () => {
    expect(groupByAssetClass(['BTCUSDT', 'XAUUSDT', 'CLUSDT', 'ETHUSDT'])).toEqual([
      { assetClass: 'crypto', symbols: ['BTCUSDT', 'ETHUSDT'] },
      { assetClass: 'metals', symbols: ['XAUUSDT'] },
      { assetClass: 'energy', symbols: ['CLUSDT'] },
    ]);
    expect(groupByAssetClass(['BTCUSDT'])).toEqual([
      { assetClass: 'crypto', symbols: ['BTCUSDT'] },
    ]);
  });
});
