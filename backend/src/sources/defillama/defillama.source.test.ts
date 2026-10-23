import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { MacroPoint } from '../../db/repositories/macro.repo.js';
import type { FetchLike, HttpResponse } from '../../ingest/exchange/adapter.js';
import type { UpstreamError } from '../../ingest/exchange/errors.js';
import { createRateLimiter } from '../../ingest/rate-limiter.js';
import type { SourceContext } from '../adapter.js';
import {
  createDefillamaClient,
  createDefillamaSource,
  STABLECOINS_SERIES_ID,
  TVL_SERIES_ID,
  type DefillamaRaw,
} from './defillama.source.js';

const NOW = Date.UTC(2026, 9, 23, 6, 7, 0);
const CONTEXT: SourceContext = { limiter: createRateLimiter({ rps: 1000 }), now: () => NOW };
const DESDE_2020 = Date.UTC(2020, 0, 1);

function fixture(name: string): unknown {
  const path = fileURLToPath(new URL(`../../__fixtures__/defillama/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

const TVL = fixture('historical-chain-tvl');
const STABLES = fixture('stablecoins-all');

function response(status: number, body: unknown): HttpResponse {
  return { status, headers: new Headers(), json: () => Promise.resolve(body) };
}

/** Nunca sale a la red: cada ruta con su fixture. */
function fakeFetch(urls: string[] = [], status = 200): FetchLike {
  return (url) => {
    urls.push(url);
    return Promise.resolve(response(status, url.includes('stablecoin') ? STABLES : TVL));
  };
}

function source(options: { urls?: string[]; from?: number; stored?: readonly MacroPoint[] } = {}) {
  const written: MacroPoint[] = [];

  return {
    written,
    adapter: createDefillamaSource({
      pool: undefined as never,
      client: createDefillamaClient({
        tvlBaseUrl: 'https://api.llama.fi',
        stablecoinsBaseUrl: 'https://stablecoins.llama.fi',
        fetch: fakeFetch(options.urls ?? []),
      }),
      schedule: '17 5 * * *',
      from: options.from ?? DESDE_2020,
      macroRepo: {
        upsertPoints: ({ points }) => {
          written.push(...points);
          return Promise.resolve(points.length);
        },
        getPoints: () => Promise.resolve([...(options.stored ?? [])]),
        getLastTs: () => Promise.resolve(null),
        getSources: () => Promise.resolve([]),
      },
    }),
  };
}

describe('cliente de DefiLlama', () => {
  it('pide las dos series a sus dos hosts', async () => {
    const urls: string[] = [];
    await source({ urls }).adapter.fetch(null, CONTEXT);

    expect(urls).toEqual([
      'https://api.llama.fi/v2/historicalChainTvl',
      'https://stablecoins.llama.fi/stablecoincharts/all',
    ]);
  });

  it('un 503 se reintenta y un 404 no', async () => {
    const caught = async (status: number): Promise<UpstreamError> => {
      const client = createDefillamaClient({
        tvlBaseUrl: 'https://api.llama.fi',
        stablecoinsBaseUrl: 'https://stablecoins.llama.fi',
        fetch: fakeFetch([], status),
      });
      try {
        await client.getHistoricalChainTvl();
      } catch (error) {
        return error as UpstreamError;
      }
      throw new Error(`se esperaba un fallo con status ${status}`);
    };

    expect((await caught(503)).retryable).toBe(true);
    expect((await caught(404)).retryable).toBe(false);
    expect((await caught(404)).message).toContain('DefiLlama respondio 404');
  });
});

describe('normalizado de DefiLlama', () => {
  async function normalized(options: Parameters<typeof source>[0] = {}) {
    const built = source(options);
    return { built, batch: built.adapter.normalize(await built.adapter.fetch(null, CONTEXT)) };
  }

  it('el TVL entra con el instante de su foto como published_at', async () => {
    const { batch } = await normalized();
    const tvl = batch.items.filter((item) => item.seriesId === TVL_SERIES_ID);

    expect(tvl).toHaveLength(4);
    expect(tvl[0]).toEqual({
      seriesId: TVL_SERIES_ID,
      t: 1_792_454_400_000,
      value: 88_836_499_173,
      publishedAt: 1_792_454_400_000,
      fetchedAt: NOW,
    });
  });

  it('el circulante de stablecoins sale de totalCirculatingUSD, no de totalCirculating', async () => {
    const { batch } = await normalized();
    const stables = batch.items.filter((item) => item.seriesId === STABLECOINS_SERIES_ID);

    expect(stables).toHaveLength(3);
    // El `date` de stablecoins llega como string: si no se convirtiera, el ts seria NaN.
    expect(stables[2]).toMatchObject({
      t: 1_792_713_600_000,
      value: 303_169_037_563.08,
    });
    expect(stables.every((item) => Number.isFinite(item.t))).toBe(true);
  });

  it('lo anterior a la ventana configurada se descarta', async () => {
    const { batch } = await normalized({ from: Date.UTC(2027, 0, 1) });

    expect(batch.items).toHaveLength(0);
    expect(batch.discarded).toBe(7);
  });

  it('una respuesta con otra forma revienta en vez de descartar en silencio', async () => {
    const { built } = await normalized();
    const raw: DefillamaRaw = { fetchedAt: NOW, tvl: [{ date: 1 }], stablecoins: [] };

    expect(() => built.adapter.normalize(raw)).toThrow();
  });
});

describe('persistencia de DefiLlama', () => {
  it('un TVL recalculado para una fecha ya guardada entra como revision', async () => {
    const built = source({
      stored: [
        {
          t: 1_792_454_400_000,
          value: 88_000_000_000,
          publishedAt: 1_792_454_400_000,
          fetchedAt: NOW - 86_400_000,
          revision: 0,
        },
      ],
    });
    const batch = built.adapter.normalize(await built.adapter.fetch(null, CONTEXT));

    await built.adapter.persist(batch);

    expect(built.written).toContainEqual(
      expect.objectContaining({ t: 1_792_454_400_000, value: 88_836_499_173, revision: 1 }),
    );
  });

  it('un valor que no ha cambiado no se reescribe', async () => {
    const built = source({
      stored: [
        {
          t: 1_792_454_400_000,
          value: 88_836_499_173,
          publishedAt: 1_792_454_400_000,
          fetchedAt: NOW - 86_400_000,
          revision: 0,
        },
      ],
    });
    const batch = built.adapter.normalize(await built.adapter.fetch(null, CONTEXT));

    const result = await built.adapter.persist(batch);

    expect(built.written.some((point) => point.t === 1_792_454_400_000)).toBe(false);
    expect(result.skipped).toBeGreaterThan(0);
  });
});
