import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RunProgress } from '@/components/RunProgress/RunProgress';
import { FakeEventSource } from '@/test/fake-event-source';
import * as fixtures from '@/test/msw/fixtures';
import { API_BASE, errorResponse } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { silentQueryClient } from '@/test/query-wrapper';

const RUN_ID = fixtures.RUN_ID;

beforeEach(() => {
  FakeEventSource.reset();
});

function renderProgress(runId: string | undefined, onDismiss?: () => void) {
  const queryClient = silentQueryClient();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RunProgress
        runId={runId}
        sseCtor={FakeEventSource}
        {...(onDismiss === undefined ? {} : { onDismiss })}
      />
    </QueryClientProvider>,
  );
  return { ...view, queryClient };
}

function emit(event: string, payload: unknown) {
  act(() => {
    FakeEventSource.last().emit(event, payload);
  });
}

describe('RunProgress', () => {
  it('sin run pide que se lance uno, sin barra ni spinner', () => {
    renderProgress(undefined);

    expect(screen.getByText(/para lanzar un run/i)).toBeDefined();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(FakeEventSource.openCount).toBe(0);
  });

  it('reengancha el SSE del runId que recibe, sin lanzar nada', () => {
    renderProgress(RUN_ID);

    expect(FakeEventSource.openCount).toBe(1);
    expect(FakeEventSource.last().url).toContain(`/api/backtests/${RUN_ID}/stream`);
  });

  it('pinta el progreso que llega por SSE: barra, barras, trades, equity y ETA', async () => {
    renderProgress(RUN_ID);

    emit('status', { runId: RUN_ID, status: 'running', barsTotal: 17_472 });
    emit('progress', {
      runId: RUN_ID,
      pct: 34.2,
      barsDone: 5975,
      trades: 41,
      equity: '10480.2',
      etaMs: 90_000,
    });

    await waitFor(() => {
      expect(screen.getByText('34.2%')).toBeDefined();
    });
    expect(screen.getByText('5.975 / 17.472')).toBeDefined();
    expect(screen.getByText('41')).toBeDefined();
    expect(screen.getByText('10.480,20')).toBeDefined();
    expect(screen.getByText('1m 30s')).toBeDefined();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('34');
  });

  it('muestra los cinco estados con su etiqueta', async () => {
    for (const [status, label] of [
      ['queued', 'En cola'],
      ['running', 'Ejecutando'],
      ['completed', 'Completado'],
      ['failed', 'Fallido'],
      ['cancelled', 'Cancelado'],
    ] as const) {
      FakeEventSource.reset();
      const view = renderProgress(RUN_ID);

      emit('status', { runId: RUN_ID, status, barsTotal: 100 });

      await waitFor(() => {
        expect(screen.getByText(label)).toBeDefined();
      });
      view.unmount();
    }
  });

  it('en cola avisa de que no hay worker en vez de dejar un spinner eterno', async () => {
    vi.useFakeTimers();
    try {
      renderProgress(RUN_ID);

      emit('status', { runId: RUN_ID, status: 'queued', barsTotal: 100 });

      expect(screen.getByText(/Esperando a que un worker/i)).toBeDefined();

      await act(async () => {
        vi.advanceTimersByTime(10_000);
        await Promise.resolve();
      });

      expect(screen.getByText(/no hay ningun worker/i)).toBeDefined();
      expect(screen.getByText(/dev:worker/i)).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('el aviso de cola no salta si el run arranca a tiempo', async () => {
    vi.useFakeTimers();
    try {
      renderProgress(RUN_ID);

      emit('status', { runId: RUN_ID, status: 'queued', barsTotal: 100 });
      emit('status', { runId: RUN_ID, status: 'running', barsTotal: 100 });

      await act(async () => {
        vi.advanceTimersByTime(60_000);
        await Promise.resolve();
      });

      expect(screen.queryByText(/no hay ningun worker/i)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancelar llama al API y la UI refleja cancelled', async () => {
    const cancelled: string[] = [];
    server.use(
      http.post(`${API_BASE}/api/backtests/:id/cancel`, ({ params }) => {
        cancelled.push(String(params.id));
        return HttpResponse.json({ runId: String(params.id), status: 'cancelled' });
      }),
    );

    renderProgress(RUN_ID);
    emit('status', { runId: RUN_ID, status: 'running', barsTotal: 100 });

    const button = await screen.findByRole('button', { name: /cancelar/i });
    act(() => {
      button.click();
    });

    await waitFor(() => {
      expect(cancelled).toEqual([RUN_ID]);
    });

    emit('done', { runId: RUN_ID, status: 'cancelled' });

    await waitFor(() => {
      expect(screen.getByText('Cancelado')).toBeDefined();
    });
    expect(screen.queryByRole('button', { name: /cancelar/i })).toBeNull();
  });

  it('un run terminado no ofrece cancelar', async () => {
    renderProgress(RUN_ID);

    emit('status', { runId: RUN_ID, status: 'completed', barsTotal: 100 });

    await waitFor(() => {
      expect(screen.getByText('Completado')).toBeDefined();
    });
    expect(screen.queryByRole('button', { name: /cancelar/i })).toBeNull();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('un 409 al cancelar se muestra en vez de tragarselo', async () => {
    server.use(
      http.post(`${API_BASE}/api/backtests/:id/cancel`, () =>
        errorResponse('CONFLICT', 'El run ya ha terminado'),
      ),
    );

    renderProgress(RUN_ID);
    emit('status', { runId: RUN_ID, status: 'running', barsTotal: 100 });

    const button = await screen.findByRole('button', { name: /cancelar/i });
    act(() => {
      button.click();
    });

    await waitFor(() => {
      expect(screen.getByText('El run ya ha terminado')).toBeDefined();
    });
  });

  it('un run fallido muestra el mensaje de error del servidor', async () => {
    renderProgress(RUN_ID);

    emit('status', { runId: RUN_ID, status: 'running', barsTotal: 100 });
    emit('error', {
      runId: RUN_ID,
      code: 'INTERNAL',
      message: 'La estrategia reviento en la barra 512',
    });
    emit('done', { runId: RUN_ID, status: 'failed' });

    await waitFor(() => {
      expect(screen.getByText('Fallido')).toBeDefined();
    });
    expect(screen.getByText('La estrategia reviento en la barra 512')).toBeDefined();
  });

  it('un run que ya fallo antes de conectar muestra el error persistido', async () => {
    server.use(
      http.get(`${API_BASE}/api/backtests/:id`, () =>
        HttpResponse.json({
          ...fixtures.run,
          status: 'failed',
          metrics: null,
          error: 'Se quedo sin velas a mitad',
        }),
      ),
    );

    renderProgress(RUN_ID);

    await waitFor(() => {
      expect(screen.getByText('Se quedo sin velas a mitad')).toBeDefined();
    });
  });

  it('al terminar ofrece cerrar y avisa al contenedor', async () => {
    const onDismiss = vi.fn();
    renderProgress(RUN_ID, onDismiss);

    emit('status', { runId: RUN_ID, status: 'completed', barsTotal: 100 });

    const close = await screen.findByRole('button', { name: /cerrar/i });
    act(() => {
      close.click();
    });

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('mientras el run no ha empezado usa el progreso persistido del run', async () => {
    server.use(
      http.get(`${API_BASE}/api/backtests/:id`, () =>
        HttpResponse.json({
          ...fixtures.run,
          status: 'running',
          metrics: null,
          progress: { barsDone: 50, barsTotal: 200 },
        }),
      ),
    );

    renderProgress(RUN_ID);

    await waitFor(() => {
      expect(screen.getByText('50 / 200')).toBeDefined();
    });
    expect(screen.getByText('25.0%')).toBeDefined();
  });
});
