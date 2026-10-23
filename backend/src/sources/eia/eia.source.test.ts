import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { MacroPoint } from '../../db/repositories/macro.repo.js';
import type { FetchLike, HttpResponse } from '../../ingest/exchange/adapter.js';
import type { UpstreamError } from '../../ingest/exchange/errors.js';
import { createRateLimiter } from '../../ingest/rate-limiter.js';
import type { SourceContext } from '../adapter.js';
import { createEiaClient } from './client.js';
import { createEiaSource, type EiaDiscard, type EiaRaw } from './eia.source.js';
import { EIA_REPORT_EVENT_TYPE, releaseInstant, toTimestamp } from './types.js';

const NOW = Date.UTC(2026, 9, 23, 15, 41, 0);
const DAY = 24 * 60 * 60 * 1000;
const CONTEXT: SourceContext = { limiter: createRateLimiter({ rps: 1000 }), now: () => NOW };
const START = '2026-10-01';
const SERIES = ['WCESTUS1', 'WGTSTUS1', 'WDISTUS1'] as const;

function fixture(name: string): unknown {
  const path = fileURLToPath(new URL(`../../__fixtures__/eia/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

const STOCKS = fixture('stocks-weekly');
const REVISADA = fixture('stocks-weekly-revisada');

function response(status: number, body: unknown): HttpResponse {
  return { status, headers: new Headers(), json: () => Promise.resolve(body) };
}

/** Nunca sale a la red: contesta siempre con el fixture dado. */
function fakeFetch(body: unknown, urls: string[] = [], status = 200): FetchLike {
  return (url) => {
    urls.push(url);
    return Promise.resolve(response(status, body));
  };
}

interface EventSpy {
  type: string;
  assetTags: readonly string[];
  payload: Record<string, unknown>;
}

interface Spy {
  points: MacroPoint[];
  events: EventSpy[];
}

interface SourceOptions {
  body?: unknown;
  urls?: string[];
  discards?: EiaDiscard[];
  /** Lo que ya habria en `macro_series`, por serie. */
  stored?: Record<string, readonly MacroPoint[]>;
}

function source(options: SourceOptions = {}) {
  const spy: Spy = { points: [], events: [] };
  const stored = options.stored ?? {};

  return {
    spy,
    adapter: createEiaSource({
      pool: undefined as never,
      client: createEiaClient({
        apiKey: 'clave-de-prueba',
        baseUrl: 'https://api.eia.gov',
        fetch: fakeFetch(options.body ?? STOCKS, options.urls ?? []),
      }),
      seriesIds: SERIES,
      schedule: '41 15 * * *',
      start: START,
      ...(options.discards === undefined
        ? {}
        : { onDiscard: (discard: EiaDiscard) => options.discards?.push(discard) }),
      macroRepo: {
        upsertPoints: ({ points }) => {
          spy.points.push(...points);
          return Promise.resolve(points.length);
        },
        getPoints: ({ seriesId }) => Promise.resolve([...(stored[seriesId] ?? [])]),
        getLastTs: () => Promise.resolve(null),
        getLastPublishedAt: () => Promise.resolve(null),
        getMaxRevisions: () => Promise.resolve(new Map()),
        getSources: () => Promise.resolve([]),
      },
      eventsRepo: {
        upsertEvents: (events) => {
          spy.events.push(
            ...events.map((event) => ({
              type: event.type,
              assetTags: event.assetTags,
              payload: event.payload,
            })),
          );
          return Promise.resolve(events.length);
        },
        getEvents: () => Promise.resolve([]),
      },
    }),
  };
}

describe('calendario de la EIA', () => {
  it('el informe de una semana se publica el miercoles siguiente a las 10:30 de Nueva York', () => {
    // Viernes 2026-10-02 -> miercoles 2026-10-07, en horario de verano (UTC-4).
    expect(releaseInstant(toTimestamp('2026-10-02'))).toBe(Date.UTC(2026, 9, 7, 14, 30));
  });

  it('el cambio de hora de Nueva York mueve la hora UTC, no la local', () => {
    // El horario de verano de 2026 va del 8 de marzo al 1 de noviembre.
    expect(releaseInstant(toTimestamp('2026-10-30'))).toBe(Date.UTC(2026, 10, 4, 15, 30));
    expect(releaseInstant(toTimestamp('2026-02-27'))).toBe(Date.UTC(2026, 2, 4, 15, 30));
    expect(releaseInstant(toTimestamp('2026-03-06'))).toBe(Date.UTC(2026, 2, 11, 14, 30));
  });

  it('un period que ya cae en miercoles espera al siguiente, no se publica a si mismo', () => {
    expect(releaseInstant(toTimestamp('2026-10-07'))).toBe(Date.UTC(2026, 9, 14, 14, 30));
  });
});

describe('cliente de la EIA', () => {
  it('pide todas las series en una peticion, con la faceta repetida', async () => {
    const urls: string[] = [];
    await source({ urls }).adapter.fetch(null, CONTEXT);

    expect(urls).toHaveLength(1);
    const url = new URL(urls[0] ?? '');
    expect(url.pathname).toBe('/v2/petroleum/stoc/wstk/data/');
    expect(url.searchParams.getAll('facets[series][]')).toEqual([...SERIES]);
    expect(url.searchParams.get('frequency')).toBe('weekly');
    expect(url.searchParams.get('data[0]')).toBe('value');
    expect(url.searchParams.get('start')).toBe(START);
    expect(url.searchParams.get('sort[0][direction]')).toBe('asc');
    expect(url.searchParams.get('api_key')).toBe('clave-de-prueba');
  });

  it('un 403 lleva el motivo de la EIA y no se reintenta; un 429 si', async () => {
    const client = (status: number) =>
      createEiaClient({
        apiKey: '',
        baseUrl: 'https://api.eia.gov',
        fetch: fakeFetch(fixture('error-missing-key'), [], status),
      });

    await expect(client(403).getWeeklyStocks(SERIES, START)).rejects.toThrow(
      /403: API_KEY_MISSING No api_key was supplied/,
    );

    const caught = async (status: number): Promise<UpstreamError> => {
      try {
        await client(status).getWeeklyStocks(SERIES, START);
      } catch (error) {
        return error as UpstreamError;
      }
      throw new Error(`se esperaba un fallo con status ${status}`);
    };

    expect((await caught(403)).retryable).toBe(false);
    expect((await caught(429)).retryable).toBe(true);
    expect((await caught(503)).retryable).toBe(true);
  });

  it('un cuerpo de error ilegible no tapa el status', async () => {
    const client = createEiaClient({
      apiKey: 'k',
      baseUrl: 'https://api.eia.gov',
      fetch: () =>
        Promise.resolve({
          status: 502,
          headers: new Headers(),
          json: () => Promise.reject(new Error('no es json')),
        }),
    });

    await expect(client.getWeeklyStocks(SERIES, START)).rejects.toThrow('la EIA respondio 502');
  });
});

describe('normalizado de la EIA', () => {
  async function normalized(options: SourceOptions = {}) {
    const built = source(options);
    const raw: EiaRaw = await built.adapter.fetch(null, CONTEXT);
    return { built, batch: built.adapter.normalize(raw) };
  }

  it('cada fila es un punto de su serie, con el published_at del informe que la trae', async () => {
    const { batch } = await normalized();
    const puntos = batch.items.filter((item) => item.kind === 'stock');

    expect(puntos).toHaveLength(5);
    expect(puntos[0]).toMatchObject({
      seriesId: 'WCESTUS1',
      t: Date.UTC(2026, 9, 2),
      value: 421_500,
      publishedAt: Date.UTC(2026, 9, 7, 14, 30),
      fetchedAt: NOW,
    });
    expect(puntos[1]).toMatchObject({ seriesId: 'WGTSTUS1', value: 223_100 });
  });

  it('un valor null se descarta con motivo y no entra como 0', async () => {
    const discards: EiaDiscard[] = [];
    const { batch } = await normalized({ discards });

    expect(batch.discarded).toBe(1);
    expect(discards).toEqual([
      {
        seriesId: 'WDISTUS1',
        period: '2026-10-16',
        reason: 'valor ausente: la EIA lo publica como null',
      },
    ]);
    expect(batch.items.some((item) => item.kind === 'stock' && item.value === 0)).toBe(false);
  });

  it('cada semana deja un solo evento, no uno por serie', async () => {
    const { batch } = await normalized();
    const informes = batch.items.filter((item) => item.kind === 'report');

    expect(informes.map((item) => item.period)).toEqual(['2026-10-02', '2026-10-09', '2026-10-16']);
    expect(informes[0]).toMatchObject({
      scheduledAt: Date.UTC(2026, 9, 7, 14, 30),
      publishedAt: Date.UTC(2026, 9, 7, 14, 30),
      fetchedAt: NOW,
    });
  });

  it('una respuesta con otra forma revienta en vez de descartar en silencio', async () => {
    const { built } = await normalized();
    const raw: EiaRaw = { fetchedAt: NOW, body: { response: { data: [{ period: '2026-10-02' }] } } };

    expect(() => built.adapter.normalize(raw)).toThrow();
  });

  it('una respuesta sin la envoltura response tampoco pasa', async () => {
    const { built } = await normalized();

    expect(() => built.adapter.normalize({ fetchedAt: NOW, body: { data: [] } })).toThrow();
  });
});

describe('persistencia de la EIA', () => {
  async function persisted(options: SourceOptions = {}) {
    const built = source(options);
    const batch = built.adapter.normalize(await built.adapter.fetch(null, CONTEXT));
    return { spy: built.spy, result: await built.adapter.persist(batch) };
  }

  it('reparte los inventarios por serie y los informes a eventos', async () => {
    const { spy, result } = await persisted();

    expect(spy.points).toHaveLength(5);
    expect(spy.events).toHaveLength(3);
    expect(result).toEqual({ written: 8, skipped: 0 });
  });

  it('el evento semanal lleva el tipo, la etiqueta oil y su period', async () => {
    const { spy } = await persisted();

    expect(spy.events[0]).toEqual({
      type: EIA_REPORT_EVENT_TYPE,
      assetTags: ['oil'],
      payload: { report: 'weekly-petroleum-status', period: '2026-10-02' },
    });
  });

  it('un valor que no ha cambiado no se reescribe', async () => {
    const { spy, result } = await persisted({
      stored: {
        WCESTUS1: [
          {
            t: Date.UTC(2026, 9, 2),
            value: 421_500,
            publishedAt: Date.UTC(2026, 9, 7, 14, 30),
            fetchedAt: NOW - DAY,
            revision: 0,
          },
        ],
      },
    });

    expect(spy.points.filter((point) => point.t === Date.UTC(2026, 9, 2))).toEqual([
      expect.objectContaining({ value: 223_100, revision: 0 }),
    ]);
    expect(result).toEqual({ written: 7, skipped: 1 });
  });

  it('un valor corregido entra como la revision siguiente, sin borrar el original', async () => {
    const { spy } = await persisted({
      body: REVISADA,
      stored: {
        WCESTUS1: [
          {
            t: Date.UTC(2026, 9, 9),
            value: 419_800,
            publishedAt: Date.UTC(2026, 9, 14, 14, 30),
            fetchedAt: NOW - DAY,
            revision: 0,
          },
        ],
      },
    });

    expect(spy.points).toContainEqual({
      t: Date.UTC(2026, 9, 9),
      value: 418_425,
      publishedAt: Date.UTC(2026, 9, 14, 14, 30),
      fetchedAt: NOW,
      revision: 1,
    });
  });
});
