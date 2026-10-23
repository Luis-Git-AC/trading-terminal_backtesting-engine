import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../db/migrate.js';
import { createEventsRepository } from '../../db/repositories/events.repo.js';
import { createMacroRepository } from '../../db/repositories/macro.repo.js';
import { createRateLimiter } from '../../ingest/rate-limiter.js';
import { createScratchDatabase, type ScratchDatabase } from '../../testing/scratch-db.js';
import { toRunnable, type SourceRunReport } from '../adapter.js';
import { createCftcClient } from './client.js';
import { createCftcSource } from './cftc.source.js';
import { CFTC_REPORT_EVENT_TYPE, CFTC_SOURCE_ID } from './types.js';

/** El informe del martes 2026-10-13 se publica el viernes 16 a las 19:30 UTC (15:30 ET). */
const MARTES = Date.UTC(2026, 9, 13);
const MIERCOLES = Date.UTC(2026, 9, 14, 12, 0);
const PUBLICACION = Date.UTC(2026, 9, 16, 19, 30);
const RECOGIDA = Date.UTC(2026, 9, 16, 20, 13);

const INFORME = readFileSync(
  fileURLToPath(new URL('../../__fixtures__/cftc/deafut-recortado.txt', import.meta.url)),
);

describe('fuente CFTC contra la base de datos', () => {
  let db: ScratchDatabase;

  beforeAll(async () => {
    db = await createScratchDatabase({ applicationName: 'tt-itest-cftc' });
    await runMigrations({ pool: db.pool });
  });

  afterAll(async () => {
    await db.drop();
  });

  beforeEach(async () => {
    await db.pool.query('DELETE FROM macro_series');
    await db.pool.query('DELETE FROM market_events');
  });

  function run(now: number): Promise<SourceRunReport> {
    const source = createCftcSource({
      pool: db.pool,
      schedule: '13 20 * * *',
      client: createCftcClient({
        url: 'https://www.cftc.gov/dea/newcot/deafut.txt',
        // Sin red: el fichero real recortado, por trozos.
        fetch: () =>
          Promise.resolve({
            status: 200,
            body: {
              *[Symbol.iterator]() {
                for (let offset = 0; offset < INFORME.byteLength; offset += 256) {
                  yield INFORME.subarray(offset, offset + 256);
                }
              },
            },
          }),
      }),
    });
    return toRunnable(source).run(null, {
      limiter: createRateLimiter({ rps: 1000 }),
      now: () => now,
    });
  }

  it('persiste el neto de los tres mercados con el martes como ts', async () => {
    const report = await run(RECOGIDA);

    expect(report).toMatchObject({ sourceId: CFTC_SOURCE_ID, items: 4, written: 4, discarded: 2 });

    const repo = createMacroRepository(db.pool);
    const series = async (seriesId: string) =>
      repo.getPoints({
        source: CFTC_SOURCE_ID,
        seriesId,
        from: MARTES,
        to: MARTES,
      });

    expect(await series('gold-net-noncommercial')).toEqual([
      {
        t: MARTES,
        value: 207_879,
        publishedAt: PUBLICACION,
        fetchedAt: RECOGIDA,
        revision: 0,
      },
    ]);
    expect(await series('silver-net-noncommercial')).toEqual([
      expect.objectContaining({ value: 22_631 }),
    ]);
    expect(await series('wti-net-noncommercial')).toEqual([
      expect.objectContaining({ value: 100_343 }),
    ]);
  });

  it('una consulta del miercoles no ve el informe del martes que se publica el viernes', async () => {
    await run(RECOGIDA);

    const repo = createMacroRepository(db.pool);
    const rango = {
      source: CFTC_SOURCE_ID,
      seriesId: 'gold-net-noncommercial',
      from: MARTES,
      to: MARTES,
    };

    // El dato es del martes, pero el miercoles nadie lo conocia: tomarlo como conocido seria
    // look-ahead bias de tres dias, el error clasico con esta serie.
    expect(await repo.getPoints({ ...rango, asOf: MIERCOLES })).toEqual([]);
    expect(await repo.getPoints({ ...rango, asOf: PUBLICACION })).toEqual([]);
    expect(await repo.getPoints({ ...rango, asOf: RECOGIDA })).toEqual([
      expect.objectContaining({ value: 207_879 }),
    ]);

    const eventos = createEventsRepository(db.pool);
    const ventana = { from: MARTES, to: Date.UTC(2026, 9, 20), tags: ['gold'] };

    expect(await eventos.getEvents({ ...ventana, asOf: MIERCOLES })).toEqual([]);
    const publicados = await eventos.getEvents({ ...ventana, asOf: RECOGIDA });
    expect(publicados).toHaveLength(1);
    expect(publicados[0]).toMatchObject({
      type: CFTC_REPORT_EVENT_TYPE,
      scheduledAt: MARTES,
      publishedAt: PUBLICACION,
      fetchedAt: RECOGIDA,
      payload: { report: 'legacy-futures-only', reportDate: '2026-10-13' },
    });
  });

  it('una segunda pasada sobre el mismo informe no duplica filas', async () => {
    await run(RECOGIDA);
    const segunda = await run(RECOGIDA + 3_600_000);

    expect(segunda).toMatchObject({ items: 4, written: 0, skipped: 4 });

    const { rows } = await db.pool.query<{ macro: string; eventos: string }>(
      `SELECT (SELECT count(*)::text FROM macro_series) AS macro,
              (SELECT count(*)::text FROM market_events) AS eventos`,
    );
    expect(rows[0]).toEqual({ macro: '3', eventos: '1' });
  });
});
