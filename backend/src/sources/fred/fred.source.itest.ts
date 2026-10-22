import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../db/migrate.js';
import { createEventsRepository } from '../../db/repositories/events.repo.js';
import { createMacroRepository } from '../../db/repositories/macro.repo.js';
import type { FetchLike } from '../../ingest/exchange/adapter.js';
import { createRateLimiter } from '../../ingest/rate-limiter.js';
import { createScratchDatabase, type ScratchDatabase } from '../../testing/scratch-db.js';
import { toRunnable, type SourceContext, type SourceRunReport } from '../adapter.js';
import { createFredClient } from './client.js';
import { createFredSource } from './fred.source.js';
import { FRED_RELEASE_EVENT_TYPE, FRED_SOURCE_ID } from './types.js';

const NOW = Date.UTC(2026, 9, 22, 6, 23, 0);
const DAY = 24 * 60 * 60 * 1000;
const CONTEXT: SourceContext = { limiter: createRateLimiter({ rps: 1000 }), now: () => NOW };

function fixture(name: string): unknown {
  const path = fileURLToPath(new URL(`../../__fixtures__/fred/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

const BODIES: Record<string, unknown> = {
  DFII10: fixture('observations-dfii10'),
  GDPC1: fixture('observations-gdpc1-revisada'),
  releases: fixture('release-dates'),
};

/** Sin red: cada petición se contesta con el fixture que corresponde a su `series_id`. */
const fakeFetch: FetchLike = (url) => {
  const seriesId = new URL(url).searchParams.get('series_id');
  return Promise.resolve({
    status: 200,
    headers: new Headers(),
    json: () => Promise.resolve(seriesId === null ? BODIES.releases : BODIES[seriesId]),
  });
};

describe('fuente FRED contra la base de datos', () => {
  let db: ScratchDatabase;

  beforeAll(async () => {
    db = await createScratchDatabase({ applicationName: 'tt-itest-fred' });
    await runMigrations({ pool: db.pool });
  });

  afterAll(async () => {
    await db.drop();
  });

  beforeEach(async () => {
    await db.pool.query('DELETE FROM macro_series');
    await db.pool.query('DELETE FROM market_events');
  });

  function run(seriesIds: readonly string[]): Promise<SourceRunReport> {
    const source = createFredSource({
      pool: db.pool,
      client: createFredClient({
        apiKey: 'clave-de-prueba',
        baseUrl: 'https://api.stlouisfed.org',
        fetch: fakeFetch,
      }),
      seriesIds,
      schedule: '23 6 * * *',
      observationStart: '2026-01-01',
    });
    return toRunnable(source).run(null, CONTEXT);
  }

  it('persiste la serie con sus published_at y descarta el valor ausente', async () => {
    const report = await run(['DFII10']);

    expect(report.sourceId).toBe(FRED_SOURCE_ID);
    expect(report.discarded).toBe(1);
    expect(report.written).toBe(6);

    const puntos = await createMacroRepository(db.pool).getPoints({
      source: FRED_SOURCE_ID,
      seriesId: 'DFII10',
      from: Date.UTC(2026, 0, 1),
      to: Date.UTC(2026, 11, 31),
    });

    expect(puntos).toEqual([
      { t: Date.UTC(2026, 9, 1), value: 1.82, publishedAt: Date.UTC(2026, 9, 2), fetchedAt: NOW, revision: 0 },
      { t: Date.UTC(2026, 9, 2), value: 1.79, publishedAt: Date.UTC(2026, 9, 3), fetchedAt: NOW, revision: 0 },
      { t: Date.UTC(2026, 9, 6), value: 1.85, publishedAt: Date.UTC(2026, 9, 7), fetchedAt: NOW, revision: 0 },
    ]);

    // El 2026-10-05 traia "." y no esta: ni como fila, ni como 0.
    expect(puntos.some((punto) => punto.t === Date.UTC(2026, 9, 5))).toBe(false);
  });

  it('una segunda pasada sobre el mismo rango no duplica filas', async () => {
    await run(['DFII10', 'GDPC1']);
    const segunda = await run(['DFII10', 'GDPC1']);

    expect(segunda.written).toBe(0);
    expect(segunda.skipped).toBe(9);

    const { rows } = await db.pool.query<{ macro: string; eventos: string }>(
      `SELECT (SELECT count(*)::text FROM macro_series) AS macro,
              (SELECT count(*)::text FROM market_events) AS eventos`,
    );
    expect(rows[0]).toEqual({ macro: '6', eventos: '3' });
  });

  it('la revision convive con el original y el point-in-time devuelve la de su fecha', async () => {
    await run(['GDPC1']);

    const repo = createMacroRepository(db.pool);
    const rango = {
      source: FRED_SOURCE_ID,
      seriesId: 'GDPC1',
      from: Date.UTC(2026, 3, 1),
      to: Date.UTC(2026, 3, 1),
    };

    const { rows } = await db.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM macro_series WHERE ts = '2026-04-01T00:00:00Z'",
    );
    expect(rows[0]?.count).toBe('2');

    // `fetched_at` es el de la recogida, el mismo para las dos revisiones, asi que el corte por
    // `asOf` no las separa: lo que las separa es `published_at`, y el repositorio devuelve la ultima.
    expect(await repo.getPoints(rango)).toEqual([
      expect.objectContaining({ value: 23_025.4, revision: 1 }),
    ]);
    expect(await repo.getPoints({ ...rango, asOf: NOW - DAY })).toEqual([]);
  });

  it('las fechas de release quedan como eventos con su scheduled_at', async () => {
    await run(['DFII10']);

    const eventos = await createEventsRepository(db.pool).getEvents({
      from: Date.UTC(2026, 0, 1),
      to: Date.UTC(2027, 0, 1),
    });

    expect(eventos.map((evento) => evento.scheduledAt)).toEqual([
      Date.UTC(2026, 10, 25),
      Date.UTC(2026, 10, 16),
      Date.UTC(2026, 9, 13),
    ]);
    expect(eventos.every((evento) => evento.type === FRED_RELEASE_EVENT_TYPE)).toBe(true);
    expect(eventos[2]?.payload).toEqual({ releaseId: 10, releaseName: 'Consumer Price Index' });
    expect(eventos[2]?.assetTags).toEqual(['macro', 'usd']);
  });

  it('los eventos se pueden filtrar por etiqueta macro', async () => {
    await run(['DFII10']);

    const eventos = await createEventsRepository(db.pool).getEvents({
      from: Date.UTC(2026, 0, 1),
      to: Date.UTC(2027, 0, 1),
      tags: ['macro'],
    });

    expect(eventos).toHaveLength(3);
  });
});
