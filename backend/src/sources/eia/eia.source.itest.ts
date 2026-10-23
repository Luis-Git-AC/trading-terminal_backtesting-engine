import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../db/migrate.js';
import { createEventsRepository } from '../../db/repositories/events.repo.js';
import { createMacroRepository } from '../../db/repositories/macro.repo.js';
import type { FetchLike } from '../../ingest/exchange/adapter.js';
import { createRateLimiter } from '../../ingest/rate-limiter.js';
import { createScratchDatabase, type ScratchDatabase } from '../../testing/scratch-db.js';
import { toRunnable, type SourceRunReport } from '../adapter.js';
import { createEiaClient } from './client.js';
import { createEiaSource } from './eia.source.js';
import { EIA_REPORT_EVENT_TYPE, EIA_SOURCE_ID } from './types.js';

const PRIMERA = Date.UTC(2026, 9, 23, 15, 41, 0);
const SEGUNDA = Date.UTC(2026, 9, 24, 15, 41, 0);
const SERIES = ['WCESTUS1', 'WGTSTUS1', 'WDISTUS1'] as const;

function fixture(name: string): unknown {
  const path = fileURLToPath(new URL(`../../__fixtures__/eia/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

const STOCKS = fixture('stocks-weekly');
const REVISADA = fixture('stocks-weekly-revisada');

/** Sin red: la peticion se contesta con el fixture que pida el caso. */
function fakeFetch(body: unknown): FetchLike {
  return () =>
    Promise.resolve({ status: 200, headers: new Headers(), json: () => Promise.resolve(body) });
}

describe('fuente EIA contra la base de datos', () => {
  let db: ScratchDatabase;

  beforeAll(async () => {
    db = await createScratchDatabase({ applicationName: 'tt-itest-eia' });
    await runMigrations({ pool: db.pool });
  });

  afterAll(async () => {
    await db.drop();
  });

  beforeEach(async () => {
    await db.pool.query('DELETE FROM macro_series');
    await db.pool.query('DELETE FROM market_events');
  });

  function run(body: unknown, now: number): Promise<SourceRunReport> {
    const source = createEiaSource({
      pool: db.pool,
      client: createEiaClient({
        apiKey: 'clave-de-prueba',
        baseUrl: 'https://api.eia.gov',
        fetch: fakeFetch(body),
      }),
      seriesIds: SERIES,
      schedule: '41 15 * * *',
      start: '2026-10-01',
    });
    return toRunnable(source).run(null, {
      limiter: createRateLimiter({ rps: 1000 }),
      now: () => now,
    });
  }

  it('persiste los inventarios con su published_at y descarta el valor ausente', async () => {
    const report = await run(STOCKS, PRIMERA);

    expect(report.sourceId).toBe(EIA_SOURCE_ID);
    expect(report.discarded).toBe(1);
    expect(report.written).toBe(8);

    const puntos = await createMacroRepository(db.pool).getPoints({
      source: EIA_SOURCE_ID,
      seriesId: 'WCESTUS1',
      from: Date.UTC(2026, 9, 1),
      to: Date.UTC(2026, 9, 31),
    });

    expect(puntos).toEqual([
      {
        t: Date.UTC(2026, 9, 2),
        value: 421_500,
        publishedAt: Date.UTC(2026, 9, 7, 14, 30),
        fetchedAt: PRIMERA,
        revision: 0,
      },
      {
        t: Date.UTC(2026, 9, 9),
        value: 419_800,
        publishedAt: Date.UTC(2026, 9, 14, 14, 30),
        fetchedAt: PRIMERA,
        revision: 0,
      },
      {
        t: Date.UTC(2026, 9, 16),
        value: 423_275.5,
        publishedAt: Date.UTC(2026, 9, 21, 14, 30),
        fetchedAt: PRIMERA,
        revision: 0,
      },
    ]);

    // Los destilados del 2026-10-16 traian null y no estan: ni como fila, ni como 0.
    const { rows } = await db.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM macro_series WHERE series_id = 'WDISTUS1'",
    );
    expect(rows[0]?.count).toBe('0');
  });

  it('una segunda pasada sobre el mismo rango no duplica filas', async () => {
    await run(STOCKS, PRIMERA);
    const segunda = await run(STOCKS, SEGUNDA);

    expect(segunda).toMatchObject({ items: 8, written: 0, skipped: 8 });

    const { rows } = await db.pool.query<{ macro: string; eventos: string }>(
      `SELECT (SELECT count(*)::text FROM macro_series) AS macro,
              (SELECT count(*)::text FROM market_events) AS eventos`,
    );
    expect(rows[0]).toEqual({ macro: '5', eventos: '3' });
  });

  it('un inventario corregido convive con el original y el point-in-time devuelve el de su fecha', async () => {
    await run(STOCKS, PRIMERA);
    const segunda = await run(REVISADA, SEGUNDA);

    expect(segunda).toMatchObject({ written: 1, skipped: 7 });

    const { rows } = await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM macro_series
       WHERE series_id = 'WCESTUS1' AND ts = '2026-10-09T00:00:00Z'`,
    );
    expect(rows[0]?.count).toBe('2');

    const repo = createMacroRepository(db.pool);
    const rango = {
      source: EIA_SOURCE_ID,
      seriesId: 'WCESTUS1',
      from: Date.UTC(2026, 9, 9),
      to: Date.UTC(2026, 9, 9),
    };

    expect(await repo.getPoints(rango)).toEqual([
      expect.objectContaining({ value: 418_425, revision: 1 }),
    ]);
    // Antes de la segunda recogida, lo que se sabia era el valor original.
    expect(await repo.getPoints({ ...rango, asOf: PRIMERA })).toEqual([
      expect.objectContaining({ value: 419_800, revision: 0 }),
    ]);
  });

  it('cada semana deja un evento con su scheduled_at y la etiqueta oil', async () => {
    await run(STOCKS, PRIMERA);

    const eventos = await createEventsRepository(db.pool).getEvents({
      from: Date.UTC(2026, 9, 1),
      to: Date.UTC(2026, 10, 1),
      tags: ['oil'],
    });

    expect(eventos.map((evento) => evento.scheduledAt)).toEqual([
      Date.UTC(2026, 9, 21, 14, 30),
      Date.UTC(2026, 9, 14, 14, 30),
      Date.UTC(2026, 9, 7, 14, 30),
    ]);
    expect(eventos.every((evento) => evento.type === EIA_REPORT_EVENT_TYPE)).toBe(true);
    expect(eventos[2]?.payload).toEqual({
      report: 'weekly-petroleum-status',
      period: '2026-10-02',
    });
    expect(eventos[2]?.publishedAt).toBe(Date.UTC(2026, 9, 7, 14, 30));
    expect(eventos[2]?.fetchedAt).toBe(PRIMERA);
  });
});
