import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import type { CreateBacktestBody } from '@tt/shared';
import { StrategyPanel } from '@/components/StrategyPanel/StrategyPanel';
import * as fixtures from '@/test/msw/fixtures';
import { API_BASE, errorResponse } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { silentQueryClient } from '@/test/query-wrapper';

const CATALOG = {
  strategies: [
    {
      id: 'ema-cross',
      name: 'EMA Cross',
      version: '1.0.0',
      description: 'Cruce de EMA rapida sobre lenta',
      params: [
        { key: 'fastPeriod', type: 'int', default: 12, min: 2, max: 200, label: 'EMA rapida' },
        { key: 'atrPeriod', type: 'int', default: 14, min: 2, max: 100, label: 'Periodo del ATR' },
        { key: 'allowShort', type: 'bool', default: true, label: 'Permitir cortos' },
      ],
    },
    {
      id: 'range-breakout',
      name: 'Range Breakout',
      version: '1.0.0',
      description: 'Ruptura del rango',
      params: [
        { key: 'lookback', type: 'int', default: 20, min: 2, max: 500, label: 'Barras del rango' },
        { key: 'atrPeriod', type: 'int', default: 30, min: 2, max: 100, label: 'Periodo del ATR' },
        {
          key: 'stopMode',
          type: 'enum',
          default: 'nearest',
          options: ['range', 'atr', 'nearest'],
          label: 'Modo de stop',
        },
      ],
    },
  ],
};

function renderPanel(onSubmit: (body: CreateBacktestBody) => void = vi.fn()) {
  server.use(
    http.get(`${API_BASE}/api/strategies`, () => HttpResponse.json(CATALOG)),
    http.get(`${API_BASE}/api/markets/:symbol/coverage`, () =>
      HttpResponse.json({
        ...fixtures.coverage,
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-06-30T23:45:00.000Z',
        gaps: [],
      }),
    ),
  );

  return render(
    <QueryClientProvider client={silentQueryClient()}>
      <StrategyPanel symbol="BTCUSDT" timeframe="15m" onSubmit={onSubmit} />
    </QueryClientProvider>,
  );
}

async function waitForForm() {
  await waitFor(() => {
    expect(screen.getByLabelText('EMA rapida')).toBeDefined();
  });
}

describe('StrategyPanel', () => {
  it('genera el formulario desde el catalogo, sin nada hardcodeado', async () => {
    renderPanel();
    await waitForForm();

    const fast = screen.getByLabelText('EMA rapida');
    expect(fast).toHaveProperty('value', '12');
    expect(fast.getAttribute('min')).toBe('2');
    expect(fast.getAttribute('max')).toBe('200');
    expect(fast.getAttribute('type')).toBe('number');

    expect(screen.getByLabelText('Permitir cortos').getAttribute('type')).toBe('checkbox');
  });

  it('cambiar de estrategia regenera el formulario con sus defaults', async () => {
    renderPanel();
    await waitForForm();

    fireEvent.change(screen.getByLabelText('Estrategia'), { target: { value: 'range-breakout' } });

    await waitFor(() => {
      expect(screen.getByLabelText('Barras del rango')).toHaveProperty('value', '20');
    });
    expect(screen.queryByLabelText('EMA rapida')).toBeNull();

    const stopMode = screen.getByLabelText('Modo de stop');
    expect(stopMode).toHaveProperty('value', 'nearest');
    expect(
      within(stopMode)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['range', 'atr', 'nearest']);
  });

  it('un parametro que comparten dos estrategias vuelve al default de la nueva, no arrastra lo editado', async () => {
    renderPanel();
    await waitForForm();

    fireEvent.change(screen.getByLabelText('Periodo del ATR'), { target: { value: '99' } });
    expect(screen.getByLabelText('Periodo del ATR')).toHaveProperty('value', '99');

    fireEvent.change(screen.getByLabelText('Estrategia'), { target: { value: 'range-breakout' } });

    await waitFor(() => {
      expect(screen.getByLabelText('Barras del rango')).toBeDefined();
    });
    expect(screen.getByLabelText('Periodo del ATR')).toHaveProperty('value', '30');
  });

  it('un valor fuera de rango da error inline y deshabilita el boton', async () => {
    renderPanel();
    await waitForForm();

    const submit = screen.getByRole('button', { name: /ejecutar/i });
    expect(submit).toHaveProperty('disabled', false);

    fireEvent.change(screen.getByLabelText('EMA rapida'), { target: { value: '999' } });

    await waitFor(() => {
      expect(submit).toHaveProperty('disabled', true);
    });
    expect(screen.getAllByText(/no puede ser mayor que 200/i).length).toBeGreaterThan(0);
    expect(screen.getByLabelText('EMA rapida').getAttribute('aria-invalid')).toBe('true');
  });

  it('un rango fuera de cobertura bloquea y explica por que', async () => {
    renderPanel();
    await waitForForm();

    fireEvent.change(screen.getByLabelText('Desde'), { target: { value: '2020-01-01' } });

    await waitFor(() => {
      expect(screen.getAllByText(/fuera de la cobertura/i).length).toBeGreaterThan(0);
    });
    expect(screen.getByRole('button', { name: /ejecutar/i })).toHaveProperty('disabled', true);
  });

  it('el rango por defecto sale de la cobertura real', async () => {
    renderPanel();
    await waitForForm();

    expect(screen.getByLabelText('Desde')).toHaveProperty('value', '2026-01-01');
    expect(screen.getByLabelText('Hasta')).toHaveProperty('value', '2026-06-30');
  });

  it('la semilla se envia tal cual se escribe', async () => {
    const onSubmit = vi.fn();
    renderPanel(onSubmit);
    await waitForForm();

    fireEvent.change(screen.getByLabelText('Semilla'), { target: { value: '4242' } });
    fireEvent.click(screen.getByRole('button', { name: /ejecutar/i }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ seed: 4242, strategyId: 'ema-cross' });
  });

  it('el boton de semilla aleatoria rellena el campo con un entero', async () => {
    renderPanel();
    await waitForForm();

    fireEvent.click(screen.getByRole('button', { name: /aleatoria/i }));

    const seed = screen.getByLabelText('Semilla');
    await waitFor(() => {
      expect(seed).not.toHaveProperty('value', '');
    });
    expect(Number.isInteger(Number((seed as HTMLInputElement).value))).toBe(true);
  });

  it('sin semilla no se manda el campo, lo genera el servidor', async () => {
    const onSubmit = vi.fn();
    renderPanel(onSubmit);
    await waitForForm();

    fireEvent.click(screen.getByRole('button', { name: /ejecutar/i }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty('seed');
  });

  it('los cambios en los parametros llegan al cuerpo enviado', async () => {
    const onSubmit = vi.fn();
    renderPanel(onSubmit);
    await waitForForm();

    fireEvent.change(screen.getByLabelText('EMA rapida'), { target: { value: '30' } });
    fireEvent.click(screen.getByLabelText('Permitir cortos'));
    fireEvent.click(screen.getByRole('button', { name: /ejecutar/i }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      params: { fastPeriod: 30, allowShort: false },
    });
  });

  it('un hueco de datos en el rango avisa sin bloquear', async () => {
    server.use(
      http.get(`${API_BASE}/api/strategies`, () => HttpResponse.json(CATALOG)),
      http.get(`${API_BASE}/api/markets/:symbol/coverage`, () =>
        HttpResponse.json({
          ...fixtures.coverage,
          from: '2026-01-01T00:00:00.000Z',
          to: '2026-06-30T23:45:00.000Z',
          gaps: [
            { from: '2026-03-02T04:15:00.000Z', to: '2026-03-02T05:00:00.000Z', filled: false },
          ],
        }),
      ),
    );

    render(
      <QueryClientProvider client={silentQueryClient()}>
        <StrategyPanel symbol="BTCUSDT" timeframe="15m" onSubmit={vi.fn()} />
      </QueryClientProvider>,
    );
    await waitForForm();

    await waitFor(() => {
      expect(screen.getByText(/hueco/i)).toBeDefined();
    });
    expect(screen.getByRole('button', { name: /ejecutar/i })).toHaveProperty('disabled', false);
  });

  it('si el catalogo falla, lo dice en vez de mostrar un formulario vacio', async () => {
    server.use(
      http.get(`${API_BASE}/api/strategies`, () => errorResponse('INTERNAL', 'Se rompio algo')),
    );

    render(
      <QueryClientProvider client={silentQueryClient()}>
        <StrategyPanel symbol="BTCUSDT" timeframe="15m" onSubmit={vi.fn()} />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('Se rompio algo')).toBeDefined();
    });
    expect(screen.queryByRole('button', { name: /ejecutar/i })).toBeNull();
  });

  it('duplicar precarga params, exec, seed y rango del run original', async () => {
    const onSubmit = vi.fn();

    server.use(
      http.get(`${API_BASE}/api/strategies`, () => HttpResponse.json(CATALOG)),
      http.get(`${API_BASE}/api/markets/:symbol/coverage`, () =>
        HttpResponse.json({
          ...fixtures.coverage,
          from: '2026-01-01T00:00:00.000Z',
          to: '2026-06-30T23:45:00.000Z',
          gaps: [],
        }),
      ),
    );

    const preset = {
      ...fixtures.run,
      strategyId: 'ema-cross',
      seed: 4242,
      label: 'el original',
      params: { fastPeriod: 55, atrPeriod: 21, allowShort: false },
      range: { from: '2026-02-01T00:00:00.000Z', to: '2026-03-15T23:45:00.000Z' },
      exec: {
        initialCapital: 25_000,
        riskPerTradePct: 2.5,
        feeBps: 4,
        slippageBps: 1,
        fillModel: 'next-open' as const,
      },
    };

    render(
      <QueryClientProvider client={silentQueryClient()}>
        <StrategyPanel symbol="BTCUSDT" timeframe="15m" onSubmit={onSubmit} preset={preset} />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByLabelText('EMA rapida')).toHaveProperty('value', '55');
    });

    expect(screen.getByLabelText('Periodo del ATR')).toHaveProperty('value', '21');
    expect(screen.getByLabelText('Permitir cortos')).toHaveProperty('checked', false);
    expect(screen.getByLabelText('Semilla')).toHaveProperty('value', '4242');
    expect(screen.getByLabelText('Capital inicial')).toHaveProperty('value', '25000');
    expect(screen.getByLabelText(/Riesgo por trade/)).toHaveProperty('value', '2.5');
    expect(screen.getByLabelText('Desde')).toHaveProperty('value', '2026-02-01');
    expect(screen.getByLabelText('Hasta')).toHaveProperty('value', '2026-03-15');

    fireEvent.click(screen.getByRole('button', { name: /ejecutar/i }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      strategyId: 'ema-cross',
      seed: 4242,
      params: { fastPeriod: 55, atrPeriod: 21, allowShort: false },
      exec: { initialCapital: 25_000, riskPerTradePct: 2.5, feeBps: 4, slippageBps: 1 },
    });
  });

  it('los errores de validacion del servidor se pintan junto a su campo', async () => {
    const submitError = Object.assign(new Error('La peticion no cumple el contrato'), {
      code: 'VALIDATION_ERROR' as const,
      status: 400,
      details: [{ path: 'body.params.fastPeriod', message: 'slowPeriod debe ser mayor' }],
      isTransport: false,
      name: 'ApiError' as const,
    });

    server.use(
      http.get(`${API_BASE}/api/strategies`, () => HttpResponse.json(CATALOG)),
      http.get(`${API_BASE}/api/markets/:symbol/coverage`, () =>
        HttpResponse.json({
          ...fixtures.coverage,
          from: '2026-01-01T00:00:00.000Z',
          to: '2026-06-30T23:45:00.000Z',
          gaps: [],
        }),
      ),
    );

    render(
      <QueryClientProvider client={silentQueryClient()}>
        <StrategyPanel
          symbol="BTCUSDT"
          timeframe="15m"
          onSubmit={vi.fn()}
          submitError={submitError}
        />
      </QueryClientProvider>,
    );
    await waitForForm();

    expect(screen.getAllByText('slowPeriod debe ser mayor').length).toBeGreaterThan(0);
  });
});
