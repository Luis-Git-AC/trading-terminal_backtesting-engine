import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { RunSummary } from '@tt/shared';
import { Runs } from '@/pages/Runs';
import * as fixtures from '@/test/msw/fixtures';
import { API_BASE } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { silentQueryClient } from '@/test/query-wrapper';

const { params: _params, exec: _exec, ...BASE } = fixtures.run;

const ID_A = fixtures.RUN_ID;
const ID_B = fixtures.OTHER_RUN_ID;

function runOf(id: string, overrides: Partial<RunSummary> = {}): RunSummary {
  return { ...BASE, id, ...overrides };
}

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{`${location.pathname}${location.search}`}</span>;
}

function renderRuns(runs: RunSummary[]) {
  server.use(http.get(`${API_BASE}/api/backtests`, () => HttpResponse.json({ runs })));

  return render(
    <QueryClientProvider client={silentQueryClient()}>
      <MemoryRouter initialEntries={['/runs']}>
        <LocationProbe />
        <Routes>
          <Route path="/runs" element={<Runs />} />
          <Route path="/" element={<span>terminal</span>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function rowFor(id: string) {
  const checkbox = await screen.findByLabelText(`Comparar el run ${id}`);
  const row = checkbox.closest('tr');
  if (row === null) {
    throw new Error('La fila no existe');
  }
  return row;
}

describe('Runs', () => {
  it('lista los runs con fecha, estrategia, serie, rango, seed y estado', async () => {
    renderRuns([runOf(ID_A)]);

    const row = await rowFor(ID_A);
    expect(within(row).getByText('ema-cross')).toBeDefined();
    expect(within(row).getByText('BTCUSDT 15m')).toBeDefined();
    expect(within(row).getByText('42')).toBeDefined();
    expect(within(row).getByText('Completado')).toBeDefined();
  });

  it('filtra por estrategia sin volver a pedir al API', async () => {
    renderRuns([runOf(ID_A), runOf(ID_B, { strategyId: 'range-breakout' })]);

    await rowFor(ID_A);
    expect(screen.getAllByRole('row')).toHaveLength(3);

    act(() => {
      const select = screen.getByLabelText(/estrategia/i);
      Object.getOwnPropertyDescriptor(globalThis.HTMLSelectElement.prototype, 'value')?.set?.call(
        select,
        'range-breakout',
      );
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    await waitFor(() => {
      expect(screen.getAllByRole('row')).toHaveLength(2);
    });
  });

  it('borrar pide confirmacion antes de llamar al API', async () => {
    const deleted: string[] = [];
    server.use(
      http.delete(`${API_BASE}/api/backtests/:id`, ({ params }) => {
        deleted.push(String(params.id));
        return new HttpResponse(null, { status: 204 });
      }),
    );

    renderRuns([runOf(ID_A)]);
    const row = await rowFor(ID_A);

    act(() => {
      within(row).getByRole('button', { name: 'Borrar' }).click();
    });

    expect(within(row).getByText('¿Borrar?')).toBeDefined();
    expect(deleted).toEqual([]);

    act(() => {
      within(row).getByRole('button', { name: 'Si' }).click();
    });

    await waitFor(() => {
      expect(deleted).toEqual([ID_A]);
    });
  });

  it('cancelar la confirmacion no borra nada', async () => {
    const deleted: string[] = [];
    server.use(
      http.delete(`${API_BASE}/api/backtests/:id`, ({ params }) => {
        deleted.push(String(params.id));
        return new HttpResponse(null, { status: 204 });
      }),
    );

    renderRuns([runOf(ID_A)]);
    const row = await rowFor(ID_A);

    act(() => {
      within(row).getByRole('button', { name: 'Borrar' }).click();
    });
    act(() => {
      within(row).getByRole('button', { name: 'No' }).click();
    });

    expect(within(row).getByRole('button', { name: 'Borrar' })).toBeDefined();
    expect(deleted).toEqual([]);
  });

  it('borrar refresca la lista', async () => {
    let served = [runOf(ID_A), runOf(ID_B)];
    server.use(
      http.get(`${API_BASE}/api/backtests`, () => HttpResponse.json({ runs: served })),
      http.delete(`${API_BASE}/api/backtests/:id`, ({ params }) => {
        served = served.filter((run) => run.id !== String(params.id));
        return new HttpResponse(null, { status: 204 });
      }),
    );

    render(
      <QueryClientProvider client={silentQueryClient()}>
        <MemoryRouter initialEntries={['/runs']}>
          <Runs />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const row = await rowFor(ID_A);
    act(() => {
      within(row).getByRole('button', { name: 'Borrar' }).click();
    });
    act(() => {
      within(row).getByRole('button', { name: 'Si' }).click();
    });

    await waitFor(() => {
      expect(screen.queryByLabelText(`Comparar el run ${ID_A}`)).toBeNull();
    });
    expect(screen.getByLabelText(`Comparar el run ${ID_B}`)).toBeDefined();
  });

  it('"Ver" lleva a la terminal con ese run', async () => {
    renderRuns([runOf(ID_A)]);
    const row = await rowFor(ID_A);

    act(() => {
      within(row).getByRole('button', { name: 'Ver' }).click();
    });

    await waitFor(() => {
      expect(screen.getByTestId('location').textContent).toBe(`/?run=${ID_A}`);
    });
  });

  it('"Duplicar" lleva a la terminal con el run a clonar', async () => {
    renderRuns([runOf(ID_A)]);
    const row = await rowFor(ID_A);

    act(() => {
      within(row).getByRole('button', { name: 'Duplicar' }).click();
    });

    await waitFor(() => {
      expect(screen.getByTestId('location').textContent).toBe(`/?duplicate=${ID_A}`);
    });
  });

  it('la seleccion para comparar se corta en 4', async () => {
    const ids = [
      ID_A,
      ID_B,
      '33333333-4444-4555-8666-777777777777',
      '44444444-5555-4666-8777-888888888888',
      '55555555-6666-4777-8888-999999999999',
    ];
    renderRuns(ids.map((id) => runOf(id)));

    await rowFor(ID_A);

    for (const id of ids.slice(0, 4)) {
      act(() => {
        screen.getByLabelText(`Comparar el run ${id}`).click();
      });
    }

    await waitFor(() => {
      expect(screen.getByLabelText(`Comparar el run ${ids[4]!}`)).toHaveProperty('disabled', true);
    });
    expect(screen.getByText(/Maximo 4 runs a la vez/i)).toBeDefined();
  });

  it('sin runs lo dice en vez de mostrar una tabla vacia', async () => {
    renderRuns([]);

    await waitFor(() => {
      expect(screen.getByText(/No hay runs con estos filtros/i)).toBeDefined();
    });
  });
});
