import { StrictMode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '@/App';
import { server } from '@/test/msw/server';
import { silentQueryClient } from '@/test/query-wrapper';

const requested: string[] = [];

function pickOption(select: HTMLElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(globalThis.HTMLSelectElement.prototype, 'value')?.set?.call(
      select,
      value,
    );
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('selector de exchange', () => {
  beforeEach(() => {
    requested.length = 0;
    server.events.removeAllListeners('request:start');
    server.events.on('request:start', ({ request }) => {
      requested.push(new URL(request.url).pathname + new URL(request.url).search);
    });
  });

  it('cambiar de exchange revalida el simbolo y pide la serie del exchange nuevo', async () => {
    render(
      <StrictMode>
        <QueryClientProvider client={silentQueryClient()}>
          <MemoryRouter initialEntries={['/']}>
            <App />
          </MemoryRouter>
        </QueryClientProvider>
      </StrictMode>,
    );

    const exchange = screen.getByRole('combobox', { name: /exchange/i });
    const symbol = screen.getByRole('combobox', { name: /simbolo/i });

    await waitFor(() => {
      expect(
        within(exchange)
          .getAllByRole('option')
          .map((option) => option.textContent),
      ).toEqual(['binance', 'hyperliquid']);
    });
    expect(exchange).toHaveProperty('value', 'binance');

    await waitFor(() => {
      expect(requested.some((path) => path.includes('/markets/binance/BTCUSDT/coverage'))).toBe(
        true,
      );
    });

    pickOption(exchange, 'hyperliquid');

    // hyperliquid no sirve BTCUSDT: el simbolo se revalida contra los suyos
    await waitFor(() => {
      expect(symbol).toHaveProperty('value', 'BTC');
    });
    expect(
      within(symbol)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['BTC']);

    await waitFor(() => {
      expect(requested.some((path) => path.includes('/markets/hyperliquid/BTC/coverage'))).toBe(
        true,
      );
    });
    await waitFor(() => {
      expect(
        requested.some(
          (path) => path.startsWith('/api/candles') && path.includes('exchange=hyperliquid'),
        ),
      ).toBe(true);
    });
  });
});
