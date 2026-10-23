import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { FetchLike, HttpResponse } from '../../ingest/exchange/adapter.js';
import type { UpstreamError } from '../../ingest/exchange/errors.js';
import { createRateLimiter } from '../../ingest/rate-limiter.js';
import type { MacroPoint } from '../../db/repositories/macro.repo.js';
import type { SourceContext } from '../adapter.js';
import { createFredClient } from './client.js';
import { createFredSource, type FredDiscard, type FredRaw } from './fred.source.js';
import {
  FRED_MAX_VINTAGE_DATES,
  FRED_RELEASE_EVENT_TYPE,
  FRED_VINTAGES_PER_REQUEST,
} from './types.js';

const NOW = Date.UTC(2026, 9, 22, 6, 23, 0);
const CONTEXT: SourceContext = { limiter: createRateLimiter({ rps: 1000 }), now: () => NOW };
const OBSERVATION_START = '2026-01-01';

function fixture(name: string): unknown {
  const path = fileURLToPath(new URL(`../../__fixtures__/fred/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

const DFII10 = fixture('observations-dfii10');
const GDPC1 = fixture('observations-gdpc1-revisada');
const RELEASES = fixture('release-dates');
const VINTAGES = fixture('vintage-dates-dfii10');

/**
 * Lista de vintages sintetica, dias consecutivos desde 2015-01-01. Es la unica forma de probar el
 * troceado: el tope del FRED son 2000 y ningun fixture real de este repositorio es tan largo.
 */
function syntheticVintages(count: number): { vintage_dates: string[] } {
  const day = 86_400_000;
  const first = Date.UTC(2015, 0, 1);
  return {
    vintage_dates: Array.from({ length: count }, (_, index) =>
      new Date(first + index * day).toISOString().slice(0, 10),
    ),
  };
}

/** Una observacion con la forma que sirve el FRED, para los raw armados a mano. */
function obs(date: string, value: string, realtimeStart: string) {
  return { date, value, realtime_start: realtimeStart, realtime_end: '9999-12-31' };
}

function response(status: number, body: unknown): HttpResponse {
  return { status, headers: new Headers(), json: () => Promise.resolve(body) };
}

/** Devuelve el fixture que toque segun la URL. Nunca sale a la red. */
function fakeFetch(
  bodies: Record<string, unknown>,
  urls: string[] = [],
  status = 200,
  vintages: unknown = VINTAGES,
): FetchLike {
  return (url) => {
    urls.push(url);
    const parsed = new URL(url);
    if (parsed.pathname === '/fred/series/vintagedates') {
      return Promise.resolve(response(status, vintages));
    }
    const seriesId = parsed.searchParams.get('series_id');
    const body = seriesId === null ? bodies.releases : bodies[seriesId];
    return Promise.resolve(response(status, body ?? { observations: [] }));
  };
}

/** Peticiones de observaciones, en orden, con su ventana realtime. */
function observationWindows(urls: readonly string[]): { start: string; end: string }[] {
  return urls
    .map((url) => new URL(url))
    .filter((url) => url.pathname === '/fred/series/observations')
    .map((url) => ({
      start: url.searchParams.get('realtime_start') ?? '',
      end: url.searchParams.get('realtime_end') ?? '',
    }));
}

function source(
  options: {
    seriesIds?: readonly string[];
    urls?: string[];
    discards?: FredDiscard[];
    status?: number;
    vintages?: unknown;
    lastPublishedAt?: number | null;
    stored?: MacroPoint[];
  } = {},
) {
  const client = createFredClient({
    apiKey: 'clave-de-prueba',
    baseUrl: 'https://api.stlouisfed.org',
    fetch: fakeFetch(
      { DFII10, GDPC1, releases: RELEASES },
      options.urls ?? [],
      options.status ?? 200,
      options.vintages ?? VINTAGES,
    ),
  });

  const written: { points: number; events: number } = { points: 0, events: 0 };
  const stored: MacroPoint[][] = [];

  return {
    written,
    stored,
    adapter: createFredSource({
      pool: undefined as never,
      client,
      seriesIds: options.seriesIds ?? ['DFII10'],
      schedule: '23 6 * * *',
      observationStart: OBSERVATION_START,
      ...(options.discards === undefined
        ? {}
        : { onDiscard: (discard: FredDiscard) => options.discards?.push(discard) }),
      macroRepo: {
        upsertPoints: ({ points }) => {
          written.points += points.length;
          stored.push([...points]);
          return Promise.resolve(points.length);
        },
        getPoints: () => Promise.resolve(options.stored ?? []),
        getLastTs: () => Promise.resolve(null),
        getLastPublishedAt: () => Promise.resolve(options.lastPublishedAt ?? null),
        getMaxRevisions: () =>
          Promise.resolve(new Map((options.stored ?? []).map((point) => [point.t, point.revision]))),
        getSources: () => Promise.resolve([]),
      },
      eventsRepo: {
        upsertEvents: (events) => {
          written.events += events.length;
          return Promise.resolve(events.length);
        },
        getEvents: () => Promise.resolve([]),
      },
    }),
  };
}

describe('cliente del FRED', () => {
  it('primero pregunta por las fechas de vintage, que son las que marcan el troceado', async () => {
    const urls: string[] = [];
    await source({ urls }).adapter.fetch(null, CONTEXT);

    const vintages = new URL(urls[0] ?? '');
    expect(vintages.pathname).toBe('/fred/series/vintagedates');
    expect(vintages.searchParams.get('series_id')).toBe('DFII10');
    expect(vintages.searchParams.get('realtime_start')).toBe(OBSERVATION_START);
    expect(vintages.searchParams.get('limit')).toBe('10000');
    expect(vintages.searchParams.get('api_key')).toBe('clave-de-prueba');
  });

  it('la ventana realtime arranca en el primer vintage y queda abierta por el final', async () => {
    const urls: string[] = [];
    await source({ urls }).adapter.fetch(null, CONTEXT);

    const observations = new URL(urls[1] ?? '');
    expect(observations.pathname).toBe('/fred/series/observations');
    // El fixture real trae tres vintages: cabe en un solo tramo.
    expect(observations.searchParams.get('realtime_start')).toBe('2026-10-20');
    expect(observations.searchParams.get('realtime_end')).toBe('9999-12-31');
    expect(observations.searchParams.get('observation_start')).toBe(OBSERVATION_START);
    expect(observations.searchParams.get('file_type')).toBe('json');
  });

  it('mas de 2000 vintages se trocean en peticiones de 1000, sin solaparse', async () => {
    const urls: string[] = [];
    const vintages = syntheticVintages(2500);
    await source({ urls, vintages }).adapter.fetch(null, CONTEXT);

    const windows = observationWindows(urls);
    expect(windows).toHaveLength(3);
    expect(windows[0]).toEqual({ start: '2015-01-01', end: vintages.vintage_dates[999] });
    expect(windows[1]).toEqual({
      start: vintages.vintage_dates[1000],
      end: vintages.vintage_dates[1999],
    });
    // El ultimo tramo no esta completo, asi que se deja abierto.
    expect(windows[2]).toEqual({ start: vintages.vintage_dates[2000], end: '9999-12-31' });
    expect(windows.every((window) => window.start <= window.end)).toBe(true);
  });

  it('ningun tramo pasa del tope de vintages del FRED', async () => {
    const urls: string[] = [];
    await source({ urls, vintages: syntheticVintages(5117) }).adapter.fetch(null, CONTEXT);

    const windows = observationWindows(urls);
    expect(windows).toHaveLength(6);
    expect(FRED_VINTAGES_PER_REQUEST).toBeLessThan(FRED_MAX_VINTAGE_DATES);
  });

  it('una segunda pasada arranca en el ultimo published_at y no repite el historico', async () => {
    const urls: string[] = [];
    await source({
      urls,
      lastPublishedAt: Date.UTC(2026, 9, 20),
      vintages: { vintage_dates: ['2026-10-20', '2026-10-21'] },
    }).adapter.fetch(null, CONTEXT);

    expect(new URL(urls[0] ?? '').searchParams.get('realtime_start')).toBe('2026-10-20');
    // Una sola peticion de observaciones, no las seis del historico completo.
    expect(observationWindows(urls)).toEqual([{ start: '2026-10-20', end: '9999-12-31' }]);
  });

  it('sin vintages nuevos no se piden observaciones', async () => {
    const urls: string[] = [];
    const raw = await source({
      urls,
      lastPublishedAt: Date.UTC(2026, 9, 22),
      vintages: { vintage_dates: [] },
    }).adapter.fetch(null, CONTEXT);

    expect(observationWindows(urls)).toEqual([]);
    expect(raw.series[0]?.bodies).toEqual([]);
  });

  it('el calendario pide las fechas sin dato, que son las futuras', async () => {
    const urls: string[] = [];
    await source({ urls }).adapter.fetch(null, CONTEXT);

    const releases = new URL(urls.at(-1) ?? '');
    expect(releases.pathname).toBe('/fred/releases/dates');
    expect(releases.searchParams.get('include_release_dates_with_no_data')).toBe('true');
    expect(releases.searchParams.get('realtime_start')).toBe('2026-09-22');
    expect(releases.searchParams.get('limit')).toBe('1000');
  });

  it('un 400 lleva el motivo del FRED y no se reintenta; un 429 si', async () => {
    const client = (status: number) =>
      createFredClient({
        apiKey: 'k',
        baseUrl: 'https://api.stlouisfed.org',
        fetch: () => Promise.resolve(response(status, fixture('error-bad-series'))),
      });

    await expect(
      client(400).getObservations('NO_EXISTE', OBSERVATION_START, '2015-01-01', '9999-12-31'),
    ).rejects.toThrow(
      /400: 400 Bad Request\.\s+The series does not exist\./,
    );

    const caught = async (status: number): Promise<UpstreamError> => {
      try {
        await client(status).getObservations(
          'DFII10',
          OBSERVATION_START,
          '2015-01-01',
          '9999-12-31',
        );
      } catch (error) {
        return error as UpstreamError;
      }
      throw new Error(`se esperaba un fallo con status ${status}`);
    };

    expect((await caught(400)).retryable).toBe(false);
    expect((await caught(429)).retryable).toBe(true);
    expect((await caught(503)).retryable).toBe(true);
  });

  it('un cuerpo de error ilegible no tapa el status', async () => {
    const client = createFredClient({
      apiKey: 'k',
      baseUrl: 'https://api.stlouisfed.org',
      fetch: () =>
        Promise.resolve({
          status: 503,
          headers: new Headers(),
          json: () => Promise.reject(new Error('no es json')),
        }),
    });

    await expect(client.getReleaseDates('2026-10-01')).rejects.toThrow('el FRED respondio 503');
  });

  it('una serie se pide por peticion propia, en el orden configurado', async () => {
    const urls: string[] = [];
    await source({ seriesIds: ['DFII10', 'GDPC1'], urls }).adapter.fetch(null, CONTEXT);

    // Dos peticiones por serie (vintages y observaciones) y una final de calendario.
    expect(urls).toHaveLength(5);
    expect(urls.map((url) => new URL(url).searchParams.get('series_id'))).toEqual([
      'DFII10',
      'DFII10',
      'GDPC1',
      'GDPC1',
      null,
    ]);
  });
});

describe('normalizado del FRED', () => {
  async function normalized(options: Parameters<typeof source>[0] = {}) {
    const built = source(options);
    const raw: FredRaw = await built.adapter.fetch(null, CONTEXT);
    return { built, batch: built.adapter.normalize(raw) };
  }

  it('el published_at sale del realtime_start de cada observacion', async () => {
    const { batch } = await normalized();
    const puntos = batch.items.filter((item) => item.kind === 'observation');

    expect(puntos).toHaveLength(3);
    expect(puntos[0]).toMatchObject({
      seriesId: 'DFII10',
      t: Date.UTC(2026, 9, 1),
      value: 1.82,
      publishedAt: Date.UTC(2026, 9, 2),
      fetchedAt: NOW,
    });
  });

  it('un valor "." se descarta con motivo y no entra como 0', async () => {
    const discards: FredDiscard[] = [];
    const { batch } = await normalized({ discards });

    expect(batch.discarded).toBe(1);
    expect(discards).toEqual([
      {
        seriesId: 'DFII10',
        date: '2026-10-05',
        value: '.',
        reason: 'valor ausente: el FRED lo publica como "."',
      },
    ]);
    expect(
      batch.items.some((item) => item.kind === 'observation' && item.value === 0),
    ).toBe(false);
  });

  it('los dos vintages de la misma fecha llegan los dos, cada uno con su published_at', async () => {
    const { batch } = await normalized({ seriesIds: ['GDPC1'] });
    const abril = batch.items.filter(
      (item) => item.kind === 'observation' && item.t === Date.UTC(2026, 3, 1),
    );

    // El numero de revision ya no sale de la respuesta: lo pone `persist` contra lo guardado.
    expect(abril).toEqual([
      expect.objectContaining({ value: 23_010.1, publishedAt: Date.UTC(2026, 6, 30) }),
      expect.objectContaining({ value: 23_025.4, publishedAt: Date.UTC(2026, 7, 28) }),
    ]);
  });

  it('los tramos de una misma serie se juntan en una sola lista de observaciones', async () => {
    const { built } = await normalized();
    const raw: FredRaw = {
      fetchedAt: NOW,
      series: [
        {
          seriesId: 'DFII10',
          bodies: [
            { observations: [obs('2026-10-01', '1.82', '2026-10-02')] },
            { observations: [obs('2026-10-02', '1.84', '2026-10-03')] },
          ],
        },
      ],
      releases: { release_dates: [] },
    };

    const items = built.adapter.normalize(raw).items.filter((item) => item.kind === 'observation');
    expect(items.map((item) => item.value)).toEqual([1.82, 1.84]);
  });

  it('las fechas de release se convierten en eventos con su scheduled_at', async () => {
    const { batch } = await normalized();
    const eventos = batch.items.filter((item) => item.kind === 'release');

    expect(eventos).toHaveLength(3);
    expect(eventos[0]).toMatchObject({
      scheduledAt: Date.UTC(2026, 9, 13),
      releaseId: 10,
      releaseName: 'Consumer Price Index',
      fetchedAt: NOW,
    });
    // Sin `release_name` se usa el id: una respuesta incompleta no tumba la recogida.
    expect(eventos[2]).toMatchObject({ releaseId: 53, releaseName: 'release 53' });
  });

  it('el published_at de un release es su propia fecha, para que el content_hash no cambie', async () => {
    const { batch } = await normalized();
    const eventos = batch.items.filter((item) => item.kind === 'release');

    expect(eventos.every((item) => item.publishedAt === item.scheduledAt)).toBe(true);
  });

  it('una respuesta con otra forma revienta en vez de descartar en silencio', async () => {
    const { built } = await normalized();
    const raw: FredRaw = {
      fetchedAt: NOW,
      series: [{ seriesId: 'DFII10', bodies: [{ observations: [{ date: '2026-10-01' }] }] }],
      releases: { release_dates: [] },
    };

    expect(() => built.adapter.normalize(raw)).toThrow();
  });
});

describe('persistencia del FRED', () => {
  it('reparte las observaciones por serie y los releases a eventos', async () => {
    const built = source({ seriesIds: ['DFII10', 'GDPC1'] });
    const batch = built.adapter.normalize(await built.adapter.fetch(null, CONTEXT));

    const result = await built.adapter.persist(batch);

    expect(built.written).toEqual({ points: 6, events: 3 });
    expect(result).toEqual({ written: 9, skipped: 0 });
  });

  it('dos vintages de la misma fecha se guardan como revision 0 y 1', async () => {
    const built = source({ seriesIds: ['GDPC1'] });
    const batch = built.adapter.normalize(await built.adapter.fetch(null, CONTEXT));

    await built.adapter.persist(batch);

    const abril = built.stored
      .flat()
      .filter((point) => point.t === Date.UTC(2026, 3, 1))
      .sort((a, b) => a.revision - b.revision);
    expect(abril).toEqual([
      expect.objectContaining({ value: 23_010.1, revision: 0 }),
      expect.objectContaining({ value: 23_025.4, revision: 1 }),
    ]);
  });

  it('una correccion que llega con el historico ya guardado continua la numeracion', async () => {
    const built = source({
      seriesIds: ['GDPC1'],
      lastPublishedAt: Date.UTC(2026, 6, 30),
      stored: [
        {
          t: Date.UTC(2026, 3, 1),
          value: 23_010.1,
          publishedAt: Date.UTC(2026, 6, 30),
          fetchedAt: Date.UTC(2026, 6, 30),
          revision: 0,
        },
      ],
    });
    const batch = built.adapter.normalize(await built.adapter.fetch(null, CONTEXT));

    await built.adapter.persist(batch);

    const abril = built.stored.flat().filter((point) => point.t === Date.UTC(2026, 3, 1));
    // El valor ya guardado no se reescribe; la correccion entra como la revision siguiente.
    expect(abril).toEqual([expect.objectContaining({ value: 23_025.4, revision: 1 })]);
  });

  it('el evento lleva el tipo y las etiquetas de la fuente', async () => {
    const eventos: MarketEventSpy[] = [];
    const built = source();
    const batch = built.adapter.normalize(await built.adapter.fetch(null, CONTEXT));

    const soloReleases = {
      ...batch,
      items: batch.items.filter((item) => item.kind === 'release'),
    };
    const adapter = createFredSource({
      pool: undefined as never,
      client: createFredClient({
        apiKey: 'k',
        baseUrl: 'https://api.stlouisfed.org',
        fetch: fakeFetch({ releases: RELEASES }),
      }),
      seriesIds: ['DFII10'],
      schedule: '23 6 * * *',
      observationStart: OBSERVATION_START,
      macroRepo: {
        upsertPoints: () => Promise.resolve(0),
        getPoints: () => Promise.resolve([]),
        getLastTs: () => Promise.resolve(null),
        getLastPublishedAt: () => Promise.resolve(null),
        getMaxRevisions: () => Promise.resolve(new Map()),
        getSources: () => Promise.resolve([]),
      },
      eventsRepo: {
        upsertEvents: (items) => {
          eventos.push(...items.map((item) => ({ type: item.type, assetTags: item.assetTags })));
          return Promise.resolve(items.length);
        },
        getEvents: () => Promise.resolve([]),
      },
    });

    await adapter.persist(soloReleases);

    expect(eventos).toHaveLength(3);
    expect(eventos[0]).toEqual({
      type: FRED_RELEASE_EVENT_TYPE,
      assetTags: ['macro', 'usd'],
    });
  });
});

interface MarketEventSpy {
  type: string;
  assetTags: readonly string[];
}
