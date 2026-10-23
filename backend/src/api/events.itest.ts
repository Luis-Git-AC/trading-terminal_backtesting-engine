import { eventsResponseSchema } from '@tt/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import { createEventsRepository, type EventsRepository } from '../db/repositories/events.repo.js';
import { createLogger } from '../observability/logger.js';
import { createScratchDatabase, type ScratchDatabase } from '../testing/scratch-db.js';
import { eventsRouter } from './routes/events.js';
import { createApiApp } from './server.js';
import { NO_CACHE, type CacheStore } from './services/cache.js';

const DAY = 86_400_000;
const START = Date.UTC(2026, 9, 1);
const NOW = Date.UTC(2026, 9, 25);
/** El COT del martes 13 se publica el viernes 16 y se descarga ese mismo dia. */
const COT_MARTES = Date.UTC(2026, 9, 13);
const COT_VIERNES = Date.UTC(2026, 9, 16, 19, 30);

describe('API de eventos', () => {
  let db: ScratchDatabase;
  let repo: EventsRepository;

  beforeAll(async () => {
    db = await createScratchDatabase({ applicationName: 'tt-itest-api-events' });
    await runMigrations({ pool: db.pool });
    repo = createEventsRepository(db.pool);
  });

  afterAll(async () => {
    await db.drop();
  });

  beforeEach(async () => {
    await db.pool.query('DELETE FROM market_events');

    await repo.upsertEvents([
      {
        source: 'fred',
        type: 'fred-release',
        assetTags: ['macro', 'usd'],
        scheduledAt: START + DAY,
        publishedAt: START + DAY,
        fetchedAt: START + DAY,
        payload: { releaseId: 10, releaseName: 'Consumer Price Index' },
      },
      {
        source: 'eia',
        type: 'eia-wpsr',
        assetTags: ['oil'],
        scheduledAt: START + 6 * DAY,
        publishedAt: START + 6 * DAY,
        fetchedAt: START + 6 * DAY,
        payload: { report: 'weekly-petroleum-status', period: '2026-10-02' },
      },
      {
        source: 'cftc',
        type: 'cftc-cot',
        assetTags: ['gold', 'silver', 'oil'],
        scheduledAt: COT_MARTES,
        publishedAt: COT_VIERNES,
        fetchedAt: COT_VIERNES,
        payload: { report: 'legacy-futures-only', reportDate: '2026-10-13' },
      },
    ]);
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
          eventsRouter({
            macro: {
              upsertPoints: () => Promise.resolve(0),
              getPoints: () => Promise.resolve([]),
              getLastTs: () => Promise.resolve(null),
              getSources: () => Promise.resolve([]),
            },
            events: repo,
            cache,
            logger: createLogger({ role: 'api', level: 'silent' }),
            now: () => NOW,
          }),
        );
      },
    });
  }

  it('devuelve los eventos del rango, del mas reciente al mas antiguo', async () => {
    const response = await request(makeApp()).get(`/api/events?from=${START}`);

    expect(response.status).toBe(200);
    expect(response.body.count).toBe(3);
    const body = eventsResponseSchema.parse(response.body);
    expect(body.events.map((event) => event.type)).toEqual([
      'cftc-cot',
      'eia-wpsr',
      'fred-release',
    ]);
    expect(response.body.events[0]).toMatchObject({
      source: 'cftc',
      assetTags: ['gold', 'silver', 'oil'],
      scheduledAt: COT_MARTES,
      publishedAt: COT_VIERNES,
      payload: { report: 'legacy-futures-only', reportDate: '2026-10-13' },
    });
    expect(response.body).toMatchObject({ asOf: null, nextTo: null });
  });

  it('asset filtra por etiqueta y acepta varias', async () => {
    const oil = await request(makeApp()).get(`/api/events?from=${START}&asset=oil`);
    expect(oil.body.count).toBe(2);

    const varias = await request(makeApp()).get(`/api/events?from=${START}&asset=gold,usd`);
    expect(eventsResponseSchema.parse(varias.body).events.map((event) => event.source)).toEqual([
      'cftc',
      'fred',
    ]);

    const ninguna = await request(makeApp()).get(`/api/events?from=${START}&asset=platinum`);
    expect(ninguna.body).toMatchObject({ count: 0, events: [] });
  });

  it('asOf no ve el COT del martes hasta que se publica el viernes', async () => {
    const miercoles = await request(makeApp()).get(
      `/api/events?from=${START}&asset=gold&asOf=${COT_MARTES + DAY}`,
    );

    expect(miercoles.status).toBe(200);
    expect(miercoles.body).toMatchObject({ count: 0, asOf: COT_MARTES + DAY });

    const despues = await request(makeApp()).get(
      `/api/events?from=${START}&asset=gold&asOf=${COT_VIERNES}`,
    );
    expect(despues.body.count).toBe(1);
  });

  it('la clave de cache incluye asOf y las etiquetas', async () => {
    const store = new Map<string, string>();
    const cache: CacheStore = {
      get: (key) => Promise.resolve(store.get(key) ?? null),
      set: (key, value) => {
        store.set(key, value);
        return Promise.resolve();
      },
    };

    await request(makeApp(cache)).get(`/api/events?from=${START}`);
    await request(makeApp(cache)).get(`/api/events?from=${START}&asOf=${COT_MARTES + DAY}`);
    await request(makeApp(cache)).get(`/api/events?from=${START}&asset=oil`);

    expect([...store.keys()]).toHaveLength(3);

    // Servida de cache y sigue siendo la suya: el COT del martes aun no esta publicado, asi que
    // son dos eventos y no los tres de la consulta sin `asOf`.
    const repetida = await request(makeApp(cache)).get(
      `/api/events?from=${START}&asOf=${COT_MARTES + DAY}`,
    );
    expect(repetida.body.count).toBe(2);
  });

  it('con limit alcanzado da nextTo para seguir hacia atras', async () => {
    const response = await request(makeApp()).get(`/api/events?from=${START}&limit=2`);

    expect(response.body.count).toBe(2);
    expect(response.body.nextTo).toBe(START + 6 * DAY - 1);

    const siguiente = await request(makeApp()).get(
      `/api/events?from=${START}&to=${response.body.nextTo}&limit=2`,
    );
    expect(eventsResponseSchema.parse(siguiente.body).events.map((event) => event.type)).toEqual([
      'fred-release',
    ]);
  });

  it('un limit por encima del tope responde RANGE_TOO_LARGE', async () => {
    const response = await request(makeApp()).get(`/api/events?from=${START}&limit=1001`);

    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe('RANGE_TOO_LARGE');
  });

  it('from obligatorio, to coherente y etiquetas validadas en el borde', async () => {
    expect((await request(makeApp()).get('/api/events')).status).toBe(400);
    expect(
      (await request(makeApp()).get(`/api/events?from=${START}&to=${START - DAY}`)).status,
    ).toBe(400);
    expect((await request(makeApp()).get(`/api/events?from=${START}&asset=`)).status).toBe(400);
    expect(
      (await request(makeApp()).get(`/api/events?from=${START}&asset=oil;drop`)).status,
    ).toBe(400);
  });
});
