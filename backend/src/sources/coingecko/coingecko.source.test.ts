import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { MacroPoint } from '../../db/repositories/macro.repo.js';
import type { FetchLike, HttpResponse } from '../../ingest/exchange/adapter.js';
import type { UpstreamError } from '../../ingest/exchange/errors.js';
import { createRateLimiter } from '../../ingest/rate-limiter.js';
import type { SourceContext } from '../adapter.js';
import {
  createCoingeckoClient,
  createCoingeckoSource,
  MARKET_CAP_SERIES_ID,
  type CoingeckoRaw,
} from './coingecko.source.js';

const NOW = Date.UTC(2026, 9, 23, 6, 11, 0);
const CONTEXT: SourceContext = { limiter: createRateLimiter({ rps: 1000 }), now: () => NOW };
/** `updated_at` real del fixture: 1792723404 s. */
const ACTUALIZADO = 1_792_723_404_000;

function fixture(name: string): unknown {
  const path = fileURLToPath(new URL(`../../__fixtures__/coingecko/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

const GLOBAL = fixture('global');
const ERROR_429 = fixture('error-429');

function response(status: number, body: unknown): HttpResponse {
  return { status, headers: new Headers(), json: () => Promise.resolve(body) };
}

function fakeFetch(body: unknown, urls: string[] = [], status = 200): FetchLike {
  return (url) => {
    urls.push(url);
    return Promise.resolve(response(status, body));
  };
}

function source(options: { body?: unknown; urls?: string[] } = {}) {
  const written: { seriesId: string; points: readonly MacroPoint[] }[] = [];

  return {
    written,
    adapter: createCoingeckoSource({
      pool: undefined as never,
      client: createCoingeckoClient({
        baseUrl: 'https://api.coingecko.com',
        fetch: fakeFetch(options.body ?? GLOBAL, options.urls ?? []),
      }),
      schedule: '31 5 * * *',
      macroRepo: {
        upsertPoints: ({ seriesId, points }) => {
          written.push({ seriesId, points });
          return Promise.resolve(points.length);
        },
        getPoints: () => Promise.resolve([]),
        getLastTs: () => Promise.resolve(null),
      },
    }),
  };
}

describe('cliente de CoinGecko', () => {
  it('pide el global del tier gratuito', async () => {
    const urls: string[] = [];
    await source({ urls }).adapter.fetch(null, CONTEXT);

    expect(urls).toEqual(['https://api.coingecko.com/api/v3/global']);
  });

  it('un 429 es reintentable y deja constancia con el motivo de CoinGecko', async () => {
    const avisos: string[] = [];
    const client = createCoingeckoClient({
      baseUrl: 'https://api.coingecko.com',
      fetch: fakeFetch(ERROR_429, [], 429),
      onRateLimited: (detail) => avisos.push(detail),
    });

    let error: UpstreamError | undefined;
    try {
      await client.getGlobal();
    } catch (caught) {
      error = caught as UpstreamError;
    }

    expect(error?.retryable).toBe(true);
    expect(error?.status).toBe(429);
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toContain('exceeded the Rate Limit');
  });

  it('un 429 sin cuerpo legible sigue siendo reintentable', async () => {
    const avisos: string[] = [];
    const client = createCoingeckoClient({
      baseUrl: 'https://api.coingecko.com',
      fetch: () =>
        Promise.resolve({
          status: 429,
          headers: new Headers(),
          json: () => Promise.reject(new Error('no es json')),
        }),
      onRateLimited: (detail) => avisos.push(detail),
    });

    await expect(client.getGlobal()).rejects.toThrow('CoinGecko respondio 429');
    expect(avisos).toEqual(['sin cuerpo que lo explique']);
  });

  it('un 404 no se reintenta y un 502 si', async () => {
    const caught = async (status: number): Promise<UpstreamError> => {
      const client = createCoingeckoClient({
        baseUrl: 'https://api.coingecko.com',
        fetch: fakeFetch(undefined, [], status),
      });
      try {
        await client.getGlobal();
      } catch (error) {
        return error as UpstreamError;
      }
      throw new Error(`se esperaba un fallo con status ${status}`);
    };

    expect((await caught(404)).retryable).toBe(false);
    expect((await caught(502)).retryable).toBe(true);
  });
});

describe('normalizado de CoinGecko', () => {
  async function normalized(options: Parameters<typeof source>[0] = {}) {
    const built = source(options);
    return { built, batch: built.adapter.normalize(await built.adapter.fetch(null, CONTEXT)) };
  }

  it('el updated_at de CoinGecko es a la vez el ts y el published_at', async () => {
    const { batch } = await normalized();

    expect(batch.items).toEqual([
      {
        seriesId: MARKET_CAP_SERIES_ID,
        t: ACTUALIZADO,
        value: 2_754_744_296_664.292,
        publishedAt: ACTUALIZADO,
        fetchedAt: NOW,
      },
      expect.objectContaining({ seriesId: 'dominance-btc', value: 59.45697048289763 }),
      expect.objectContaining({ seriesId: 'dominance-eth', value: 10.642124089282182 }),
    ]);
  });

  it('una dominancia que falta se cuenta como descartada, no como 0', async () => {
    const { batch } = await normalized({
      body: {
        data: {
          total_market_cap: { usd: 1 },
          market_cap_percentage: { btc: 50 },
          updated_at: 1_792_723_404,
        },
      },
    });

    expect(batch.discarded).toBe(1);
    expect(batch.items.map((item) => item.seriesId)).toEqual([
      MARKET_CAP_SERIES_ID,
      'dominance-btc',
    ]);
  });

  it('una respuesta con otra forma revienta en vez de descartar en silencio', async () => {
    const { built } = await normalized();
    const raw: CoingeckoRaw = { fetchedAt: NOW, body: { data: { updated_at: 1 } } };

    expect(() => built.adapter.normalize(raw)).toThrow();
  });
});

describe('persistencia de CoinGecko', () => {
  it('cada serie va por separado y todas con revision 0', async () => {
    const built = source();
    const batch = built.adapter.normalize(await built.adapter.fetch(null, CONTEXT));

    const result = await built.adapter.persist(batch);

    expect(built.written.map((entry) => entry.seriesId)).toEqual([
      MARKET_CAP_SERIES_ID,
      'dominance-btc',
      'dominance-eth',
    ]);
    expect(built.written.every((entry) => entry.points.every((point) => point.revision === 0))).toBe(
      true,
    );
    expect(result).toEqual({ written: 3, skipped: 0 });
  });
});
