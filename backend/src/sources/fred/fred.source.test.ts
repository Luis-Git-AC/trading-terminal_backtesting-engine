import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { FetchLike, HttpResponse } from '../../ingest/exchange/adapter.js';
import type { UpstreamError } from '../../ingest/exchange/errors.js';
import { createRateLimiter } from '../../ingest/rate-limiter.js';
import type { SourceContext } from '../adapter.js';
import { createFredClient } from './client.js';
import { createFredSource, type FredDiscard, type FredRaw } from './fred.source.js';
import { FRED_RELEASE_EVENT_TYPE } from './types.js';

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

function response(status: number, body: unknown): HttpResponse {
  return { status, headers: new Headers(), json: () => Promise.resolve(body) };
}

/** Devuelve el fixture que toque segun la URL. Nunca sale a la red. */
function fakeFetch(
  bodies: Record<string, unknown>,
  urls: string[] = [],
  status = 200,
): FetchLike {
  return (url) => {
    urls.push(url);
    const seriesId = new URL(url).searchParams.get('series_id');
    const body = seriesId === null ? bodies.releases : bodies[seriesId];
    return Promise.resolve(response(status, body ?? { observations: [] }));
  };
}

function source(
  options: {
    seriesIds?: readonly string[];
    urls?: string[];
    discards?: FredDiscard[];
    status?: number;
  } = {},
) {
  const client = createFredClient({
    apiKey: 'clave-de-prueba',
    baseUrl: 'https://api.stlouisfed.org',
    fetch: fakeFetch(
      { DFII10, GDPC1, releases: RELEASES },
      options.urls ?? [],
      options.status ?? 200,
    ),
  });

  const written: { points: number; events: number } = { points: 0, events: 0 };

  return {
    written,
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
          return Promise.resolve(points.length);
        },
        getPoints: () => Promise.resolve([]),
        getLastTs: () => Promise.resolve(null),
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
  it('pide la ventana realtime completa, que es la que trae las revisiones', async () => {
    const urls: string[] = [];
    await source({ urls }).adapter.fetch(null, CONTEXT);

    const observations = new URL(urls[0] ?? '');
    expect(observations.pathname).toBe('/fred/series/observations');
    expect(observations.searchParams.get('realtime_start')).toBe('1776-07-04');
    expect(observations.searchParams.get('realtime_end')).toBe('9999-12-31');
    expect(observations.searchParams.get('observation_start')).toBe(OBSERVATION_START);
    expect(observations.searchParams.get('file_type')).toBe('json');
    expect(observations.searchParams.get('api_key')).toBe('clave-de-prueba');
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

    await expect(client(400).getObservations('NO_EXISTE', OBSERVATION_START)).rejects.toThrow(
      /400: 400 Bad Request\.\s+The series does not exist\./,
    );

    const caught = async (status: number): Promise<UpstreamError> => {
      try {
        await client(status).getObservations('DFII10', OBSERVATION_START);
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

    expect(urls).toHaveLength(3);
    expect(urls.map((url) => new URL(url).searchParams.get('series_id'))).toEqual([
      'DFII10',
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
      revision: 0,
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

  it('dos vintages de la misma fecha son dos revisiones, ordenadas por realtime_start', async () => {
    const { batch } = await normalized({ seriesIds: ['GDPC1'] });
    const abril = batch.items.filter(
      (item) => item.kind === 'observation' && item.t === Date.UTC(2026, 3, 1),
    );

    expect(abril).toEqual([
      expect.objectContaining({ value: 23_010.1, revision: 0, publishedAt: Date.UTC(2026, 6, 30) }),
      expect.objectContaining({ value: 23_025.4, revision: 1, publishedAt: Date.UTC(2026, 7, 28) }),
    ]);

    // Una fecha con un solo vintage sigue siendo la revision 0.
    const julio = batch.items.filter(
      (item) => item.kind === 'observation' && item.t === Date.UTC(2026, 6, 1),
    );
    expect(julio).toEqual([expect.objectContaining({ revision: 0 })]);
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
      series: [{ seriesId: 'DFII10', body: { observations: [{ date: '2026-10-01' }] } }],
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
