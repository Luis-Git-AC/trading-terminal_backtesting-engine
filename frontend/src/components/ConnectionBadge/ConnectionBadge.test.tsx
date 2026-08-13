import { useEffect } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { MemoryRouter } from 'react-router';
import type { HealthResponse } from '@tt/shared';
import { describe, expect, it, vi } from 'vitest';
import { App } from '@/App';
import type { ConnectionState } from '@/hooks/useEventSource';
import { FakeEventSource } from '@/test/fake-event-source';
import {
  ConnectionBadge,
  feedDetail,
  feedTone,
  formatAge,
  ingestSummary,
} from '@/components/ConnectionBadge/ConnectionBadge';
import { LiveStatusProvider, useLiveStatus } from '@/state/live-status';
import * as fixtures from '@/test/msw/fixtures';
import { API_BASE, errorResponse } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { silentQueryClient } from '@/test/query-wrapper';

vi.mock('lightweight-charts', () => import('@/test/fake-lightweight-charts'));

function healthWith(ingest: HealthResponse['checks']['ingest']): HealthResponse {
  return { ...fixtures.health, checks: { ...fixtures.health.checks, ingest } };
}

function Publisher({ state }: { state: ConnectionState }) {
  const { setCandleStream } = useLiveStatus();

  useEffect(() => {
    setCandleStream(state);
  }, [state, setCandleStream]);

  return null;
}

function renderBadge(stream: ConnectionState = 'disconnected') {
  return render(
    <QueryClientProvider client={silentQueryClient()}>
      <LiveStatusProvider>
        <Publisher state={stream} />
        <ConnectionBadge />
      </LiveStatusProvider>
    </QueryClientProvider>,
  );
}

describe('ingestSummary', () => {
  it('sin bloque de ingesta no hay resumen que pintar', () => {
    expect(ingestSummary(healthWith(undefined))).toBeNull();
    expect(ingestSummary(undefined)).toBeNull();
  });

  it('la forma detallada conserva la edad de la ultima vela', () => {
    expect(ingestSummary(healthWith({ status: 'ok', lastCandleAgeSec: 12 }))).toEqual({
      degraded: false,
      lastCandleAgeSec: 12,
    });
  });

  it('degraded del backend es lo que marca el atraso, no un umbral inventado aqui', () => {
    expect(ingestSummary(healthWith({ status: 'degraded', lastCandleAgeSec: 900 }))?.degraded).toBe(
      true,
    );
  });

  it('el literal corto tambien se entiende: error degrada, ok no', () => {
    expect(ingestSummary(healthWith('error'))).toEqual({ degraded: true, lastCandleAgeSec: null });
    expect(ingestSummary(healthWith('ok'))).toEqual({ degraded: false, lastCandleAgeSec: null });
  });
});

describe('feedTone', () => {
  const fresh = { degraded: false, lastCandleAgeSec: 12 };
  const stale = { degraded: true, lastCandleAgeSec: 900 };

  it('con el API caido no se pinta nada mas: sin conexion', () => {
    expect(feedTone('connected', fresh, true)).toBe('offline');
  });

  it('la ingesta atrasada gana al estado del stream', () => {
    expect(feedTone('connected', stale, false)).toBe('stale');
    expect(feedTone('connecting', stale, false)).toBe('stale');
  });

  it('con la ingesta al dia manda el estado del SSE de velas', () => {
    expect(feedTone('connected', fresh, false)).toBe('live');
    expect(feedTone('connecting', fresh, false)).toBe('connecting');
    expect(feedTone('disconnected', fresh, false)).toBe('offline');
  });

  it('sin bloque de ingesta el badge sigue reflejando el stream', () => {
    expect(feedTone('connected', null, false)).toBe('live');
    expect(feedTone('disconnected', null, false)).toBe('offline');
  });
});

describe('formatAge', () => {
  it('escala de segundos a minutos y a horas', () => {
    expect(formatAge(0)).toBe('0 s');
    expect(formatAge(59)).toBe('59 s');
    expect(formatAge(60)).toBe('1 min');
    expect(formatAge(3599)).toBe('59 min');
    expect(formatAge(3600)).toBe('1 h');
  });

  it('sin dato no inventa un cero', () => {
    expect(formatAge(null)).toBeNull();
    expect(formatAge(Number.NaN)).toBeNull();
  });
});

describe('feedDetail', () => {
  it('el atraso se explica con la edad de la ultima vela', () => {
    expect(feedDetail('stale', { degraded: true, lastCandleAgeSec: 900 })).toContain(
      'ultima vela hace 15 min',
    );
  });

  it('sin salud del API el detalle lo dice en vez de callar', () => {
    expect(feedDetail('offline', null)).toContain('El API no responde');
  });
});

describe('ConnectionBadge', () => {
  it('con la ingesta al dia y el stream abierto dice «En vivo» y la edad de la vela', async () => {
    server.use(http.get(`${API_BASE}/api/health`, () => HttpResponse.json(fixtures.health)));

    renderBadge('connected');

    expect(await screen.findByText('12 s')).toBeDefined();
    expect(screen.getByText('En vivo')).toBeDefined();
  });

  it('con la ingesta degradada avisa de datos atrasados aunque el stream este abierto', async () => {
    server.use(
      http.get(`${API_BASE}/api/health`, () =>
        HttpResponse.json(healthWith({ status: 'degraded', lastCandleAgeSec: 900 })),
      ),
    );

    renderBadge('connected');

    expect(await screen.findByText('15 min')).toBeDefined();
    expect(screen.getByText('Datos atrasados')).toBeDefined();
  });

  it('montado en la app, refleja el stream de velas real del chart', async () => {
    FakeEventSource.reset();
    globalThis.EventSource ??= FakeEventSource as unknown as typeof globalThis.EventSource;

    render(
      <QueryClientProvider client={silentQueryClient()}>
        <MemoryRouter initialEntries={['/']}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const header = screen.getByRole('banner');
    await waitFor(() => {
      expect(within(header).getByText('Sin conexion')).toBeDefined();
    });

    const stream = await waitFor(() => {
      const found = FakeEventSource.instances.find((source) =>
        source.url.includes('/stream/candles'),
      );
      if (found === undefined) {
        throw new Error('el chart todavia no ha abierto el stream de velas');
      }
      return found;
    });

    act(() => {
      stream.open();
    });

    await waitFor(() => {
      expect(within(header).getByText('En vivo')).toBeDefined();
    });

    act(() => {
      stream.dropGivingUp();
    });

    await waitFor(() => {
      expect(within(header).getByText('Sin conexion')).toBeDefined();
    });
  });

  it('con el API caido dice «Sin conexion» en vez de quedarse en «En vivo»', async () => {
    server.use(http.get(`${API_BASE}/api/health`, () => errorResponse('INTERNAL', 'todo mal')));

    renderBadge('connected');

    await waitFor(() => {
      expect(screen.getByText('Sin conexion')).toBeDefined();
    });
  });
});
