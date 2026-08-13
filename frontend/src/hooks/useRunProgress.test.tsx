import { act, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '@/api/query-keys';
import { useRunProgress } from '@/hooks/useRunProgress';
import { FakeEventSource } from '@/test/fake-event-source';
import * as fixtures from '@/test/msw/fixtures';
import { renderHookWithQuery, silentQueryClient } from '@/test/query-wrapper';

const RUN_ID = fixtures.RUN_ID;

beforeEach(() => {
  FakeEventSource.reset();
});

function renderProgress(runId: string | undefined, queryClient = silentQueryClient()) {
  return renderHookWithQuery(() => useRunProgress(runId, { ctor: FakeEventSource }), queryClient);
}

describe('useRunProgress', () => {
  it('abre el stream del run y refleja status y progreso', async () => {
    const { result } = renderProgress(RUN_ID);

    expect(FakeEventSource.last().url).toContain(`/api/backtests/${RUN_ID}/stream`);

    act(() => {
      FakeEventSource.last().open();
      FakeEventSource.last().emit('status', {
        runId: RUN_ID,
        status: 'running',
        barsTotal: 17_472,
      });
    });

    await waitFor(() => {
      expect(result.current.status).toBe('running');
    });
    expect(result.current.barsTotal).toBe(17_472);

    act(() => {
      FakeEventSource.last().emit('progress', {
        runId: RUN_ID,
        pct: 34.2,
        barsDone: 5975,
        trades: 41,
        equity: '10480.2',
        etaMs: 2600,
      });
    });

    expect(result.current.progress?.pct).toBe(34.2);
    expect(result.current.progress?.trades).toBe(41);
  });

  it('el evento done invalida la query del run exactamente una vez', async () => {
    const queryClient = silentQueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderProgress(RUN_ID, queryClient);

    act(() => {
      FakeEventSource.last().emit('done', { runId: RUN_ID, status: 'completed' });
    });

    await waitFor(() => {
      expect(result.current.finished).toBe(true);
    });

    expect(result.current.status).toBe('completed');
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.run(RUN_ID) });
  });

  it('un done repetido no vuelve a invalidar', async () => {
    const queryClient = silentQueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderProgress(RUN_ID, queryClient);
    const connection = FakeEventSource.last();

    act(() => {
      connection.emit('done', { runId: RUN_ID, status: 'completed' });
      connection.emit('done', { runId: RUN_ID, status: 'completed' });
    });

    await waitFor(() => {
      expect(result.current.finished).toBe(true);
    });

    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('tras done cierra el stream y no se queda abierto', async () => {
    const { result } = renderProgress(RUN_ID);
    const connection = FakeEventSource.last();

    act(() => {
      connection.emit('done', { runId: RUN_ID, status: 'completed' });
    });

    await waitFor(() => {
      expect(connection.closeCalls).toBe(1);
    });

    expect(result.current.connectionState).toBe('disconnected');
    expect(FakeEventSource.openCount).toBe(1);
  });

  it('un run ya terminado al conectar (status + done inmediatos) no reabre el stream', () => {
    vi.useFakeTimers();
    try {
      const { result } = renderProgress(RUN_ID);
      const connection = FakeEventSource.last();

      act(() => {
        connection.emit('status', { runId: RUN_ID, status: 'completed', barsTotal: 100 });
        connection.emit('done', { runId: RUN_ID, status: 'completed' });
        connection.dropGivingUp();
      });

      act(() => {
        vi.advanceTimersByTime(120_000);
      });

      expect(FakeEventSource.openCount).toBe(1);
      expect(result.current.finished).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('el evento error se expone con code y message', async () => {
    const { result } = renderProgress(RUN_ID);

    act(() => {
      FakeEventSource.last().emit('error', {
        runId: RUN_ID,
        code: 'INTERNAL',
        message: 'La estrategia reviento',
      });
    });

    await waitFor(() => {
      expect(result.current.error?.code).toBe('INTERNAL');
    });
    expect(result.current.error?.message).toBe('La estrategia reviento');
  });

  it('sin runId no abre nada', () => {
    const { result } = renderProgress(undefined);

    expect(FakeEventSource.openCount).toBe(0);
    expect(result.current.connectionState).toBe('disconnected');
  });

  it('desmontar cierra el stream', () => {
    const { unmount } = renderProgress(RUN_ID);
    const connection = FakeEventSource.last();

    unmount();

    expect(connection.closeCalls).toBe(1);
  });

  it('cambiar de run resetea el estado y abre el stream del nuevo', async () => {
    const queryClient = silentQueryClient();
    const { result, rerender } = renderHookWithQuery(
      ({ runId }: { runId: string }) => useRunProgress(runId, { ctor: FakeEventSource }),
      queryClient,
      { runId: RUN_ID },
    );

    act(() => {
      FakeEventSource.last().emit('done', { runId: RUN_ID, status: 'completed' });
    });
    await waitFor(() => {
      expect(result.current.finished).toBe(true);
    });

    rerender({ runId: fixtures.OTHER_RUN_ID });

    await waitFor(() => {
      expect(result.current.finished).toBe(false);
    });
    expect(result.current.status).toBeUndefined();
    expect(FakeEventSource.last().url).toContain(fixtures.OTHER_RUN_ID);
  });
});
