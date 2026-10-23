import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../db/migrate.js';
import { createMacroRepository } from '../../db/repositories/macro.repo.js';
import type { FetchLike } from '../../ingest/exchange/adapter.js';
import { createRateLimiter } from '../../ingest/rate-limiter.js';
import { createScratchDatabase, type ScratchDatabase } from '../../testing/scratch-db.js';
import { toRunnable, type SourceRunReport } from '../adapter.js';
import {
  createDefillamaClient,
  createDefillamaSource,
  DEFILLAMA_SOURCE_ID,
  STABLECOINS_SERIES_ID,
  TVL_SERIES_ID,
} from './defillama.source.js';

const PRIMERA = Date.UTC(2026, 9, 23, 6, 7, 0);
const SEGUNDA = Date.UTC(2026, 9, 24, 6, 7, 0);
const DESDE_2020 = Date.UTC(2020, 0, 1);
const PRIMER_TVL = 1_792_454_400_000;

function fixture(name: string): unknown {
  const path = fileURLToPath(new URL(`../../__fixtures__/defillama/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

const TVL = fixture('historical-chain-tvl') as { date: number; tvl: number }[];
const STABLES = fixture('stablecoins-all');

/** Sin red: cada ruta con su fixture, con el TVL que pida el caso. */
function fakeFetch(tvl: unknown): FetchLike {
  return (url) =>
    Promise.resolve({
      status: 200,
      headers: new Headers(),
      json: () => Promise.resolve(url.includes('stablecoin') ? STABLES : tvl),
    });
}

describe('fuente DefiLlama contra la base de datos', () => {
  let db: ScratchDatabase;

  beforeAll(async () => {
    db = await createScratchDatabase({ applicationName: 'tt-itest-defillama' });
    await runMigrations({ pool: db.pool });
  });

  afterAll(async () => {
    await db.drop();
  });

  beforeEach(async () => {
    await db.pool.query('DELETE FROM macro_series');
  });

  function run(now: number, tvl: unknown = TVL): Promise<SourceRunReport> {
    const source = createDefillamaSource({
      pool: db.pool,
      schedule: '17 5 * * *',
      from: DESDE_2020,
      client: createDefillamaClient({
        tvlBaseUrl: 'https://api.llama.fi',
        stablecoinsBaseUrl: 'https://stablecoins.llama.fi',
        fetch: fakeFetch(tvl),
      }),
    });
    return toRunnable(source).run(null, {
      limiter: createRateLimiter({ rps: 1000 }),
      now: () => now,
    });
  }

  it('persiste las dos series con el instante de su foto como published_at', async () => {
    const report = await run(PRIMERA);

    expect(report).toMatchObject({ sourceId: DEFILLAMA_SOURCE_ID, items: 7, written: 7 });

    const repo = createMacroRepository(db.pool);
    const tvl = await repo.getPoints({
      source: DEFILLAMA_SOURCE_ID,
      seriesId: TVL_SERIES_ID,
      from: PRIMER_TVL,
      to: PRIMER_TVL,
    });

    expect(tvl).toEqual([
      {
        t: PRIMER_TVL,
        value: 88_836_499_173,
        publishedAt: PRIMER_TVL,
        fetchedAt: PRIMERA,
        revision: 0,
      },
    ]);

    const stables = await repo.getPoints({
      source: DEFILLAMA_SOURCE_ID,
      seriesId: STABLECOINS_SERIES_ID,
      from: Date.UTC(2026, 9, 1),
      to: Date.UTC(2026, 9, 31),
    });
    expect(stables).toHaveLength(3);
    expect(stables[2]).toMatchObject({ value: 303_169_037_563.08 });
  });

  it('una segunda pasada sobre el mismo historico no duplica filas', async () => {
    await run(PRIMERA);
    const segunda = await run(SEGUNDA);

    expect(segunda).toMatchObject({ items: 7, written: 0, skipped: 7 });

    const { rows } = await db.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM macro_series',
    );
    expect(rows[0]?.count).toBe('7');
  });

  it('un TVL recalculado convive con el original y el point-in-time devuelve el de su fecha', async () => {
    await run(PRIMERA);

    const corregido = TVL.map((point) =>
      point.date * 1000 === PRIMER_TVL ? { ...point, tvl: 90_000_000_000 } : point,
    );
    const segunda = await run(SEGUNDA, corregido);

    expect(segunda).toMatchObject({ written: 1, skipped: 6 });

    const repo = createMacroRepository(db.pool);
    const rango = {
      source: DEFILLAMA_SOURCE_ID,
      seriesId: TVL_SERIES_ID,
      from: PRIMER_TVL,
      to: PRIMER_TVL,
    };

    expect(await repo.getPoints(rango)).toEqual([
      expect.objectContaining({ value: 90_000_000_000, revision: 1 }),
    ]);
    expect(await repo.getPoints({ ...rango, asOf: PRIMERA })).toEqual([
      expect.objectContaining({ value: 88_836_499_173, revision: 0 }),
    ]);
  });
});
