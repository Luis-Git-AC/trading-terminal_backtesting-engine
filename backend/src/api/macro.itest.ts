import { macroSeriesResponseSchema } from '@tt/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import { createMacroRepository, type MacroRepository } from '../db/repositories/macro.repo.js';
import { createLogger } from '../observability/logger.js';
import { createScratchDatabase, type ScratchDatabase } from '../testing/scratch-db.js';
import { macroRouter } from './routes/macro.js';
import { createApiApp } from './server.js';
import { NO_CACHE, type CacheStore } from './services/cache.js';

const DAY = 86_400_000;
const START = Date.UTC(2026, 9, 1);
const NOW = Date.UTC(2026, 9, 25);
/** Cuando se recogio la primera version del punto del dia 2, y cuando llego su correccion. */
const PRIMERA = Date.UTC(2026, 9, 3);
const CORRECCION = Date.UTC(2026, 9, 10);

describe('API de series macro', () => {
  let db: ScratchDatabase;
  let repo: MacroRepository;

  beforeAll(async () => {
    db = await createScratchDatabase({ applicationName: 'tt-itest-api-macro' });
    await runMigrations({ pool: db.pool });
    repo = createMacroRepository(db.pool);
  });

  afterAll(async () => {
    await db.drop();
  });

  beforeEach(async () => {
    await db.pool.query('DELETE FROM macro_series');

    await repo.upsertPoints({
      source: 'fred',
      seriesId: 'DFII10',
      points: [
        { t: START, value: 1.8, publishedAt: START, fetchedAt: PRIMERA, revision: 0 },
        { t: START + DAY, value: 1.82, publishedAt: START + DAY, fetchedAt: PRIMERA, revision: 0 },
        {
          t: START + 2 * DAY,
          value: 1.79,
          publishedAt: START + 2 * DAY,
          fetchedAt: PRIMERA,
          revision: 0,
        },
        // La correccion del tercer punto, descargada una semana despues.
        {
          t: START + 2 * DAY,
          value: 1.91,
          publishedAt: CORRECCION,
          fetchedAt: CORRECCION,
          revision: 1,
        },
      ],
    });

    // La misma serie publicada por otra fuente: el id solo es ambiguo.
    await repo.upsertPoints({
      source: 'eia',
      seriesId: 'DFII10',
      points: [{ t: START, value: 99, publishedAt: START, fetchedAt: PRIMERA, revision: 0 }],
    });
  });

  function makeApp(cache: CacheStore = NO_CACHE) {
    return createApiApp({
      logger: createLogger({ role: 'api', level: 'silent' }),
      webOrigin: 'https://terminal.example',
      version: '0.1.0',
      uptimeSec: () => 1,
      checkDb: () => Promise.resolve(),
      checkRedis: () => Promise.resolve(),
      registerRoutes: (router) => {
        router.use(
          macroRouter({
            macro: repo,
            events: {
              upsertEvents: () => Promise.resolve(0),
              getEvents: () => Promise.resolve([]),
            },
            cache,
            logger: createLogger({ role: 'api', level: 'silent' }),
            now: () => NOW,
          }),
        );
      },
    });
  }

  it('devuelve la serie por rango con la revision mas alta de cada fecha', async () => {
    const response = await request(makeApp()).get(
      `/api/macro/series/DFII10?from=${START}&source=fred`,
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      source: 'fred',
      seriesId: 'DFII10',
      count: 3,
      points: [
        { t: START, value: 1.8, publishedAt: START, fetchedAt: PRIMERA, revision: 0 },
        { t: START + DAY, value: 1.82, publishedAt: START + DAY, fetchedAt: PRIMERA, revision: 0 },
        {
          t: START + 2 * DAY,
          value: 1.91,
          publishedAt: CORRECCION,
          fetchedAt: CORRECCION,
          revision: 1,
        },
      ],
      asOf: null,
      nextFrom: null,
    });
  });

  it('asOf devuelve lo que se sabia entonces, no la correccion posterior', async () => {
    const antes = await request(makeApp()).get(
      `/api/macro/series/DFII10?from=${START}&source=fred&asOf=${PRIMERA}`,
    );

    expect(antes.status).toBe(200);
    const body = macroSeriesResponseSchema.parse(antes.body);
    expect(body.asOf).toBe(PRIMERA);
    expect(body.points.at(-1)).toEqual({
      t: START + 2 * DAY,
      value: 1.79,
      publishedAt: START + 2 * DAY,
      fetchedAt: PRIMERA,
      revision: 0,
    });

    // Y antes de la primera descarga no se sabia nada en absoluto.
    const nada = await request(makeApp()).get(
      `/api/macro/series/DFII10?from=${START}&source=fred&asOf=${START}`,
    );
    expect(nada.body).toMatchObject({ count: 0, points: [] });
  });

  it('la clave de cache incluye asOf: dos consultas distintas no se mezclan', async () => {
    const store = new Map<string, string>();
    const cache: CacheStore = {
      get: (key) => Promise.resolve(store.get(key) ?? null),
      set: (key, value) => {
        store.set(key, value);
        return Promise.resolve();
      },
    };

    const sinAsOf = await request(makeApp(cache)).get(
      `/api/macro/series/DFII10?from=${START}&source=fred`,
    );
    const conAsOf = await request(makeApp(cache)).get(
      `/api/macro/series/DFII10?from=${START}&source=fred&asOf=${PRIMERA}`,
    );

    expect(macroSeriesResponseSchema.parse(sinAsOf.body).points.at(-1)?.value).toBe(1.91);
    expect(macroSeriesResponseSchema.parse(conAsOf.body).points.at(-1)?.value).toBe(1.79);
    expect([...store.keys()]).toHaveLength(2);

    // La segunda vez se sirve de cache y sigue siendo la suya.
    const repetida = await request(makeApp(cache)).get(
      `/api/macro/series/DFII10?from=${START}&source=fred&asOf=${PRIMERA}`,
    );
    expect(macroSeriesResponseSchema.parse(repetida.body).points.at(-1)?.value).toBe(1.79);
  });

  it('con limit alcanzado da nextFrom para seguir', async () => {
    const response = await request(makeApp()).get(
      `/api/macro/series/DFII10?from=${START}&source=fred&limit=2`,
    );

    expect(response.body.count).toBe(2);
    expect(response.body.nextFrom).toBe(START + DAY + 1);

    const siguiente = await request(makeApp()).get(
      `/api/macro/series/DFII10?from=${response.body.nextFrom}&source=fred&limit=2`,
    );
    expect(siguiente.body.points[0].t).toBe(START + 2 * DAY);
  });

  it('un limit por encima del tope responde RANGE_TOO_LARGE', async () => {
    const response = await request(makeApp()).get(
      `/api/macro/series/DFII10?from=${START}&source=fred&limit=5001`,
    );

    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe('RANGE_TOO_LARGE');
  });

  it('una serie que no existe es 404 y una fuente que no la publica tambien', async () => {
    const serie = await request(makeApp()).get(`/api/macro/series/NO_EXISTE?from=${START}`);
    expect(serie.status).toBe(404);
    expect(serie.body.error.code).toBe('NOT_FOUND');

    const fuente = await request(makeApp()).get(
      `/api/macro/series/DFII10?from=${START}&source=cftc`,
    );
    expect(fuente.status).toBe(404);
  });

  it('un id publicado por dos fuentes sin elegir una es un error que lo dice', async () => {
    const response = await request(makeApp()).get(`/api/macro/series/DFII10?from=${START}`);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(response.body.error.details)).toContain('eia, fred');
  });

  it('from sin valor y to anterior a from se rechazan en el borde', async () => {
    const sinFrom = await request(makeApp()).get('/api/macro/series/DFII10');
    expect(sinFrom.status).toBe(400);
    expect(sinFrom.body.error.code).toBe('VALIDATION_ERROR');

    const alReves = await request(makeApp()).get(
      `/api/macro/series/DFII10?from=${START}&to=${START - DAY}&source=fred`,
    );
    expect(alReves.status).toBe(400);

    const idRaro = await request(makeApp()).get(`/api/macro/series/dfii10;drop?from=${START}`);
    expect(idRaro.status).toBe(400);
  });
});
