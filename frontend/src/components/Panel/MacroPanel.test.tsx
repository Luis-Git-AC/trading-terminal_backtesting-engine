import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import {
  eventBucketMs,
  eventLabel,
  eventMarkers,
  MAX_EVENT_MARKERS,
  type MarketEventView,
} from '@/components/Chart/markers';
import { FALLBACK_THEME } from '@/components/Chart/theme';
import { MacroPanel } from '@/components/Panel/MacroPanel';
import { eventTagsFor, macroSeriesFor } from '@/components/Panel/macro-context';
import * as fixtures from '@/test/msw/fixtures';
import { API_BASE } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { silentQueryClient } from '@/test/query-wrapper';

const TO = 1_785_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const EVENTS: MarketEventView[] = fixtures.marketEvents.events.map((event) => ({
  scheduledAt: event.scheduledAt,
  type: event.type,
  payload: event.payload,
}));

function renderPanel(symbol: string, events: readonly MarketEventView[] = EVENTS) {
  return render(
    <QueryClientProvider client={silentQueryClient()}>
      <MacroPanel symbol={symbol} to={TO} events={events} />
    </QueryClientProvider>,
  );
}

describe('contexto macro por clase de activo', () => {
  it('cada clase mira sus propias series', () => {
    expect(macroSeriesFor('XAUUSDT').map((spec) => spec.seriesId)).toEqual(['DFII10', 'DTWEXBGS']);
    expect(macroSeriesFor('CLUSDT').map((spec) => spec.seriesId)).toEqual([
      'WCESTUS1',
      'wti-net-noncommercial',
    ]);
    // Lo que no esta en la tabla de clases es crypto, igual que en las sesiones de F8-T5.
    expect(macroSeriesFor('BTCUSDT').map((spec) => spec.seriesId)).toEqual([
      'stablecoins-circulating-usd',
      'dominance-btc',
    ]);
  });

  it('las etiquetas de evento tambien dependen de la clase', () => {
    expect(eventTagsFor('XAUUSDT')).toContain('gold');
    expect(eventTagsFor('CLUSDT')).toContain('oil');
    expect(eventTagsFor('CLUSDT')).not.toContain('gold');
    // El calendario macro lo ven las tres.
    expect(eventTagsFor('BTCUSDT')).toContain('macro');
  });
});

describe('marcas de eventos sobre las velas', () => {
  it('la marca lleva el tipo y el dato del evento, en su timestamp', () => {
    const markers = eventMarkers(EVENTS, FALLBACK_THEME, HOUR);

    expect(markers).toHaveLength(2);
    expect(markers[0]).toMatchObject({
      time: Math.floor(1_784_900_000_000 / 1000),
      position: 'aboveBar',
      shape: 'circle',
      color: FALLBACK_THEME.event,
      text: 'EIA 2026-07-17',
    });
    expect(markers[1]?.text).toBe('COT 2026-07-21');
  });

  it('un tipo desconocido se pinta con su propio tipo, no se descarta', () => {
    expect(eventLabel({ scheduledAt: TO, type: 'nuevo-evento', payload: {} })).toBe('nuevo-evento');
  });

  it('con muchos eventos se agrupan en vez de pintar doscientas banderitas', () => {
    const muchos: MarketEventView[] = Array.from({ length: 200 }, (_, index) => ({
      scheduledAt: TO + index * HOUR,
      type: 'fred-release',
      payload: { releaseName: `R${String(index)}` },
    }));
    const bucket = eventBucketMs(TO, TO + 200 * HOUR, HOUR);

    const markers = eventMarkers(muchos, FALLBACK_THEME, bucket);

    expect(markers.length).toBeLessThanOrEqual(MAX_EVENT_MARKERS + 1);
    expect(markers.some((marker) => /\d+ eventos/.test(String(marker.text)))).toBe(true);
  });

  it('el tramo nunca baja de una vela, para que dos marcas no se pisen', () => {
    expect(eventBucketMs(TO, TO + HOUR, HOUR)).toBe(HOUR);
    expect(eventBucketMs(TO, TO + 240 * DAY, HOUR)).toBeGreaterThan(HOUR);
  });

  it('sin eventos no hay marcas', () => {
    expect(eventMarkers([], FALLBACK_THEME, HOUR)).toEqual([]);
  });
});

describe('panel macro', () => {
  it('pinta las series de la clase del simbolo con su ultimo valor', async () => {
    renderPanel('XAUUSDT');

    await waitFor(() => {
      expect(screen.getAllByText('1.76 %').length).toBeGreaterThan(0);
    });
    expect(screen.getByTestId('macro-card-DFII10')).toBeDefined();
    expect(screen.getByText('Tipo real 10 anos')).toBeDefined();
    expect(screen.getByText('Indice del dolar')).toBeDefined();
  });

  it('al cambiar de clase de activo cambian las tarjetas', async () => {
    const { unmount } = renderPanel('XAUUSDT');
    await waitFor(() => {
      expect(screen.getByTestId('macro-card-DFII10')).toBeDefined();
    });
    unmount();

    renderPanel('CLUSDT');
    await waitFor(() => {
      expect(screen.getByTestId('macro-card-WCESTUS1')).toBeDefined();
    });
    expect(screen.queryByTestId('macro-card-DFII10')).toBeNull();
  });

  it('lista los eventos del rango con su fecha', async () => {
    renderPanel('CLUSDT');

    await waitFor(() => {
      expect(screen.getByText('COT 2026-07-21')).toBeDefined();
    });
    // La fecha que se pinta es el `scheduled_at` del evento, no el dato de su payload.
    expect(screen.getByText('2026-07-25')).toBeDefined();
  });

  it('un rango sin eventos muestra un estado vacio explicito', () => {
    renderPanel('BTCUSDT', []);

    expect(screen.getByText('Ningun evento en este rango')).toBeDefined();
  });

  it('una serie sin datos recogidos lo dice en vez de pintar un grafico vacio', async () => {
    server.use(
      http.get(`${API_BASE}/api/macro/series/:seriesId`, () =>
        HttpResponse.json({ ...fixtures.macroSeries, count: 0, points: [] }),
      ),
    );

    renderPanel('BTCUSDT');

    await waitFor(() => {
      expect(screen.getAllByText('Sin datos recogidos todavia').length).toBe(2);
    });
  });
});
