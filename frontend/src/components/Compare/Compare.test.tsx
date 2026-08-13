import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { COMPARE_MAX_IDS, type RunSummary } from '@tt/shared';
import { CompareView, mergeCurves } from '@/components/Compare/CompareView';
import {
  COMPARE_METRICS,
  MAX_COMPARE,
  bestIndex,
  canCompare,
  metricNumber,
  mismatchWarnings,
  toggleSelection,
} from '@/components/Compare/compare';
import * as fixtures from '@/test/msw/fixtures';
import { API_BASE, errorResponse } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { silentQueryClient } from '@/test/query-wrapper';

const { params: _params, exec: _exec, ...BASE } = fixtures.run;

function runOf(id: string, overrides: Partial<RunSummary> = {}): RunSummary {
  return { ...BASE, id, ...overrides };
}

const ID_A = fixtures.RUN_ID;
const ID_B = fixtures.OTHER_RUN_ID;
const ID_C = '33333333-4444-4555-8666-777777777777';
const ID_D = '44444444-5555-4666-8777-888888888888';
const ID_E = '55555555-6666-4777-8888-999999999999';

function metricsWith(overrides: Partial<NonNullable<RunSummary['metrics']>>) {
  return { ...fixtures.run.metrics!, ...overrides };
}

function compareResponse(runs: RunSummary[]) {
  return {
    runs,
    curves: runs.map((run, index) => ({
      runId: run.id,
      points: [
        { t: 1_785_000_000_000, value: 100 },
        { t: 1_785_003_600_000, value: 100 + index * 5 },
      ],
    })),
    warnings: [],
  };
}

function renderCompare(ids: readonly string[]) {
  return render(
    <QueryClientProvider client={silentQueryClient()}>
      <CompareView ids={ids} />
    </QueryClientProvider>,
  );
}

describe('toggleSelection', () => {
  it('anade y quita runs de la seleccion', () => {
    expect(toggleSelection([], 'a')).toEqual(['a']);
    expect(toggleSelection(['a', 'b'], 'a')).toEqual(['b']);
  });

  it('no deja pasar de 4, que es el maximo del contrato', () => {
    expect(MAX_COMPARE).toBe(COMPARE_MAX_IDS);

    const four = ['a', 'b', 'c', 'd'];
    expect(toggleSelection(four, 'e')).toEqual(four);
    expect(toggleSelection(four, 'e')).toHaveLength(4);
  });

  it('deseleccionar libera hueco para otro', () => {
    const four = ['a', 'b', 'c', 'd'];
    const three = toggleSelection(four, 'b');

    expect(toggleSelection(three, 'e')).toEqual(['a', 'c', 'd', 'e']);
  });
});

describe('canCompare', () => {
  it('hacen falta al menos 2 y como mucho 4', () => {
    expect(canCompare([])).toBe(false);
    expect(canCompare(['a'])).toBe(false);
    expect(canCompare(['a', 'b'])).toBe(true);
    expect(canCompare(['a', 'b', 'c', 'd'])).toBe(true);
    expect(canCompare(['a', 'b', 'c', 'd', 'e'])).toBe(false);
  });
});

describe('bestIndex', () => {
  it('elige el mayor o el menor segun la metrica', () => {
    expect(bestIndex([1, 5, 3], 'higher')).toBe(1);
    expect(bestIndex([1, 5, 3], 'lower')).toBe(0);
  });

  it('sin direccion no hay ganador', () => {
    expect(bestIndex([1, 5], null)).toBeNull();
  });

  it('un empate no resalta a nadie', () => {
    expect(bestIndex([5, 5], 'higher')).toBeNull();
  });

  it('ignora los null y no gana nadie si solo queda uno', () => {
    expect(bestIndex([null, 5, 3], 'higher')).toBe(1);
    expect(bestIndex([null, 5], 'higher')).toBeNull();
  });

  it('con perdidas, "mayor" sigue siendo la menos mala', () => {
    expect(bestIndex([-2, -0.5], 'higher')).toBe(1);
  });
});

describe('metricNumber', () => {
  it('convierte los importes que vienen como string', () => {
    expect(metricNumber(fixtures.run.metrics, 'netProfit')).toBe(1843.21);
  });

  it('los null y las banderas no son comparables', () => {
    expect(metricNumber(metricsWith({ profitFactor: null }), 'profitFactor')).toBeNull();
    expect(metricNumber(fixtures.run.metrics, 'openAtEnd')).toBeNull();
    expect(metricNumber(null, 'netProfit')).toBeNull();
  });
});

describe('mismatchWarnings', () => {
  it('sin diferencias no avisa de nada', () => {
    expect(mismatchWarnings([runOf(ID_A), runOf(ID_B)])).toEqual([]);
  });

  it('avisa de simbolos distintos', () => {
    const warnings = mismatchWarnings([runOf(ID_A), runOf(ID_B, { symbol: 'ETHUSDT' })]);

    expect(warnings.some((w) => w.includes('Simbolos distintos'))).toBe(true);
  });

  it('avisa de timeframes distintos', () => {
    const warnings = mismatchWarnings([runOf(ID_A), runOf(ID_B, { timeframe: '1h' })]);

    expect(warnings.some((w) => w.includes('Timeframes distintos'))).toBe(true);
  });

  it('avisa de rangos distintos', () => {
    const warnings = mismatchWarnings([
      runOf(ID_A),
      runOf(ID_B, { range: { from: '2020-01-01T00:00:00.000Z', to: '2020-06-01T00:00:00.000Z' } }),
    ]);

    expect(warnings.some((w) => w.includes('Rangos de fechas distintos'))).toBe(true);
  });

  it('avisa de versiones del motor distintas', () => {
    const warnings = mismatchWarnings([runOf(ID_A), runOf(ID_B, { engineVersion: '2.0.0' })]);

    expect(warnings.some((w) => w.includes('Versiones del motor'))).toBe(true);
  });

  it('acumula todos los avisos que apliquen', () => {
    const warnings = mismatchWarnings([
      runOf(ID_A),
      runOf(ID_B, { symbol: 'ETHUSDT', timeframe: '1h', engineVersion: '2.0.0' }),
    ]);

    expect(warnings).toHaveLength(3);
  });

  it('con un solo run no hay nada que comparar', () => {
    expect(mismatchWarnings([runOf(ID_A)])).toEqual([]);
  });
});

describe('mergeCurves', () => {
  it('alinea las curvas por marca de tiempo', () => {
    const rows = mergeCurves([
      {
        runId: 'a',
        points: [
          { t: 2, value: 110 },
          { t: 1, value: 100 },
        ],
      },
      {
        runId: 'b',
        points: [
          { t: 1, value: 100 },
          { t: 3, value: 90 },
        ],
      },
    ]);

    expect(rows).toEqual([
      { t: 1, a: 100, b: 100 },
      { t: 2, a: 110 },
      { t: 3, b: 90 },
    ]);
  });
});

describe('CompareView', () => {
  it('con menos de 2 runs pide seleccionar mas', () => {
    renderCompare([ID_A]);

    expect(screen.getByText(/Selecciona entre 2 y 4 runs/i)).toBeDefined();
  });

  it('compara 2 runs: tabla, curvas y cabeceras', async () => {
    server.use(
      http.get(`${API_BASE}/api/backtests/compare`, () =>
        HttpResponse.json(compareResponse([runOf(ID_A), runOf(ID_B)])),
      ),
    );

    renderCompare([ID_A, ID_B]);

    await waitFor(() => {
      expect(screen.getByTestId('compare-curves')).toBeDefined();
    });
    expect(screen.getAllByRole('columnheader')).toHaveLength(3);
    expect(screen.getByText(COMPARE_METRICS[0]!.label)).toBeDefined();
  });

  it('compara 4 runs', async () => {
    const runs = [ID_A, ID_B, ID_C, ID_D].map((id) => runOf(id));
    server.use(
      http.get(`${API_BASE}/api/backtests/compare`, () => HttpResponse.json(compareResponse(runs))),
    );

    renderCompare([ID_A, ID_B, ID_C, ID_D]);

    await waitFor(() => {
      expect(screen.getAllByRole('columnheader')).toHaveLength(5);
    });
  });

  it('con 5 runs no llega a pedir la comparativa', async () => {
    let requests = 0;
    server.use(
      http.get(`${API_BASE}/api/backtests/compare`, () => {
        requests += 1;
        return HttpResponse.json(compareResponse([runOf(ID_A)]));
      }),
    );

    renderCompare([ID_A, ID_B, ID_C, ID_D, ID_E]);

    await waitFor(() => {
      expect(screen.getByText(/Cargando comparativa/i)).toBeDefined();
    });
    expect(requests).toBe(0);
  });

  it('resalta la mejor cifra de cada fila', async () => {
    server.use(
      http.get(`${API_BASE}/api/backtests/compare`, () =>
        HttpResponse.json(
          compareResponse([
            runOf(ID_A, { metrics: metricsWith({ netProfit: '100' }) }),
            runOf(ID_B, { metrics: metricsWith({ netProfit: '900' }) }),
          ]),
        ),
      ),
    );

    renderCompare([ID_A, ID_B]);

    await waitFor(() => {
      expect(screen.getByText('900,00')).toBeDefined();
    });
    expect(screen.getByText('900,00').getAttribute('data-best')).toBe('true');
    expect(screen.getByText('100,00').getAttribute('data-best')).toBeNull();
  });

  it('en drawdown gana el menor, no el mayor', async () => {
    server.use(
      http.get(`${API_BASE}/api/backtests/compare`, () =>
        HttpResponse.json(
          compareResponse([
            runOf(ID_A, { metrics: metricsWith({ maxDrawdown: 0.4 }) }),
            runOf(ID_B, { metrics: metricsWith({ maxDrawdown: 0.1 }) }),
          ]),
        ),
      ),
    );

    renderCompare([ID_A, ID_B]);

    await waitFor(() => {
      expect(screen.getByText('10,00%')).toBeDefined();
    });
    expect(screen.getByText('10,00%').getAttribute('data-best')).toBe('true');
    expect(screen.getByText('40,00%').getAttribute('data-best')).toBeNull();
  });

  it('muestra los avisos de incompatibilidad', async () => {
    server.use(
      http.get(`${API_BASE}/api/backtests/compare`, () =>
        HttpResponse.json(
          compareResponse([
            runOf(ID_A),
            runOf(ID_B, { symbol: 'ETHUSDT', engineVersion: '2.0.0' }),
          ]),
        ),
      ),
    );

    renderCompare([ID_A, ID_B]);

    await waitFor(() => {
      expect(screen.getByText(/Simbolos distintos/i)).toBeDefined();
    });
    expect(screen.getByText(/Versiones del motor/i)).toBeDefined();
  });

  it('tambien muestra los avisos que manda el servidor', async () => {
    server.use(
      http.get(`${API_BASE}/api/backtests/compare`, () =>
        HttpResponse.json({
          ...compareResponse([runOf(ID_A), runOf(ID_B)]),
          warnings: ['engine-version-mismatch'],
        }),
      ),
    );

    renderCompare([ID_A, ID_B]);

    await waitFor(() => {
      expect(screen.getByText('engine-version-mismatch')).toBeDefined();
    });
  });

  it('un error del API se muestra en vez de una tabla vacia', async () => {
    server.use(
      http.get(`${API_BASE}/api/backtests/compare`, () =>
        errorResponse('NOT_FOUND', 'No existe alguno de los runs'),
      ),
    );

    renderCompare([ID_A, ID_B]);

    await waitFor(() => {
      expect(screen.getByText('No existe alguno de los runs')).toBeDefined();
    });
  });

  it('un run sin metricas no rompe la tabla', async () => {
    server.use(
      http.get(`${API_BASE}/api/backtests/compare`, () =>
        HttpResponse.json(
          compareResponse([runOf(ID_A), runOf(ID_B, { metrics: null, status: 'failed' })]),
        ),
      ),
    );

    renderCompare([ID_A, ID_B]);

    await waitFor(() => {
      expect(screen.getByTestId('compare-curves')).toBeDefined();
    });

    const rows = screen.getAllByRole('row');
    const netProfitRow = rows.find((row) => within(row).queryByText('Beneficio neto') !== null);
    expect(netProfitRow).toBeDefined();
    expect(within(netProfitRow!).getByText('—')).toBeDefined();
  });
});
