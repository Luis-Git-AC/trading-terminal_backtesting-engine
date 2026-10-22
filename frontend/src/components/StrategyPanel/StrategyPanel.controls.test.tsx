import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { StrategyPanel, presetRange } from '@/components/StrategyPanel/StrategyPanel';
import * as fixtures from '@/test/msw/fixtures';
import { API_BASE } from '@/test/msw/handlers';
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
        { key: 'allowShort', type: 'bool', default: true, label: 'Permitir cortos' },
      ],
    },
  ],
};

function renderPanel() {
  server.use(
    http.get(`${API_BASE}/api/strategies`, () => HttpResponse.json(CATALOG)),
    http.get(`${API_BASE}/api/markets/:exchange/:symbol/coverage`, () =>
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
      <StrategyPanel exchange="binance" symbol="BTCUSDT" timeframe="15m" onSubmit={vi.fn()} />
    </QueryClientProvider>,
  );
}

async function waitForForm() {
  await waitFor(() => {
    expect(screen.getByLabelText('EMA rapida')).toBeDefined();
  });
}

describe('presetRange', () => {
  it('«Todo» cubre la cobertura entera', () => {
    expect(presetRange(null, '2026-01-01', '2026-06-30')).toEqual({
      from: '2026-01-01',
      to: '2026-06-30',
    });
  });

  it('los ultimos N dias acaban en el ultimo dia con datos e incluyen ese dia', () => {
    expect(presetRange(7, '2026-01-01', '2026-06-30')).toEqual({
      from: '2026-06-24',
      to: '2026-06-30',
    });
  });

  it('si la cobertura es mas corta que N dias no se sale de ella', () => {
    expect(presetRange(30, '2026-06-20', '2026-06-30')).toEqual({
      from: '2026-06-20',
      to: '2026-06-30',
    });
  });

  it('sin cobertura no propone nada', () => {
    expect(presetRange(7, '', '')).toBeNull();
  });
});

describe('controles del panel de parametros', () => {
  it('los botones + y − cambian el parametro sin teclear y respetan sus limites', async () => {
    renderPanel();
    await waitForForm();

    fireEvent.click(screen.getByRole('button', { name: 'Aumentar EMA rapida' }));
    expect(screen.getByLabelText('EMA rapida')).toHaveProperty('value', '13');

    fireEvent.change(screen.getByLabelText('EMA rapida'), { target: { value: '200' } });
    fireEvent.click(screen.getByRole('button', { name: 'Aumentar EMA rapida' }));
    expect(screen.getByLabelText('EMA rapida')).toHaveProperty('value', '200');

    fireEvent.click(screen.getByRole('button', { name: 'Reducir EMA rapida' }));
    expect(screen.getByLabelText('EMA rapida')).toHaveProperty('value', '199');
  });

  it('las unidades de ejecucion avanzan con su propio paso', async () => {
    renderPanel();
    await waitForForm();

    fireEvent.click(screen.getByRole('button', { name: 'Aumentar Fee' }));
    expect(screen.getByLabelText('Fee (bps)')).toHaveProperty('value', '6.5');
  });

  it('los atajos de rango rellenan las fechas y marcan el activo', async () => {
    renderPanel();
    await waitForForm();

    const quick = screen.getByRole('group', { name: 'Rango rapido' });
    expect(within(quick).getByRole('button', { name: 'Todo' }).getAttribute('aria-pressed')).toBe(
      'true',
    );

    fireEvent.click(within(quick).getByRole('button', { name: '7 d' }));

    expect(screen.getByLabelText('Desde')).toHaveProperty('value', '2026-06-24');
    expect(screen.getByLabelText('Hasta')).toHaveProperty('value', '2026-06-30');
    expect(within(quick).getByRole('button', { name: '7 d' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(within(quick).getByRole('button', { name: 'Todo' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
  });

  it('el booleano es un interruptor que sigue siendo una casilla accesible', async () => {
    renderPanel();
    await waitForForm();

    const toggle = screen.getByRole('switch', { name: 'Permitir cortos' });
    expect(toggle).toHaveProperty('checked', true);

    fireEvent.click(toggle);
    expect(toggle).toHaveProperty('checked', false);
  });
});
