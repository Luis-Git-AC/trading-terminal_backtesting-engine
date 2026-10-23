import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../migrate.js';
import { createScratchDatabase, type ScratchDatabase } from '../../testing/scratch-db.js';
import { createEventsRepository, eventContentHash, type MarketEventInput } from './events.repo.js';
import { createMacroRepository, type MacroPoint } from './macro.repo.js';

const DAY = 24 * 60 * 60 * 1000;
const SOURCE = 'fred';
const SERIES = 'GDPC1';

/** El dato del trimestre: su `ts` es el periodo que mide, no el dia en que se publico. */
const TS = Date.UTC(2026, 6, 1);
const FIRST_RELEASE = Date.UTC(2026, 7, 30);
const REVISED_RELEASE = Date.UTC(2026, 8, 29);

const ORIGINAL: MacroPoint = {
  t: TS,
  value: 23_100.5,
  publishedAt: FIRST_RELEASE,
  fetchedAt: FIRST_RELEASE,
  revision: 0,
};

const REVISED: MacroPoint = {
  t: TS,
  value: 23_050.25,
  publishedAt: REVISED_RELEASE,
  fetchedAt: REVISED_RELEASE,
  revision: 1,
};

function event(overrides: Partial<MarketEventInput> = {}): MarketEventInput {
  return {
    source: 'te',
    type: 'fomc',
    assetTags: ['rates', 'usd'],
    scheduledAt: Date.UTC(2026, 10, 18, 19, 0, 0),
    publishedAt: Date.UTC(2026, 0, 2),
    fetchedAt: Date.UTC(2026, 0, 2),
    payload: { titulo: 'Decision de tipos', consenso: 3.75 },
    ...overrides,
  };
}

describe('macro_series y market_events', () => {
  let db: ScratchDatabase;

  beforeAll(async () => {
    db = await createScratchDatabase({ applicationName: 'tt-itest-macro' });
    await runMigrations({ pool: db.pool });
  });

  afterAll(async () => {
    await db.drop();
  });

  beforeEach(async () => {
    await db.pool.query('DELETE FROM macro_series');
    await db.pool.query('DELETE FROM market_events');
  });

  describe('revisiones y point-in-time', () => {
    it('insertar una revision no borra la anterior', async () => {
      const repo = createMacroRepository(db.pool);

      expect(
        await repo.upsertPoints({ source: SOURCE, seriesId: SERIES, points: [ORIGINAL] }),
      ).toBe(1);
      expect(await repo.upsertPoints({ source: SOURCE, seriesId: SERIES, points: [REVISED] })).toBe(
        1,
      );

      const { rows } = await db.pool.query<{ revision: number; value: string }>(
        'SELECT revision, value FROM macro_series ORDER BY revision',
      );
      expect(rows.map((row) => row.revision)).toEqual([0, 1]);
      expect(rows.map((row) => Number(row.value))).toEqual([23_100.5, 23_050.25]);
    });

    it('la consulta point-in-time devuelve la revision que se conocia en esa fecha', async () => {
      const repo = createMacroRepository(db.pool);
      await repo.upsertPoints({ source: SOURCE, seriesId: SERIES, points: [ORIGINAL, REVISED] });

      const range = { source: SOURCE, seriesId: SERIES, from: TS - DAY, to: TS + DAY };

      // Una vela de principios de septiembre solo podia saber la publicacion original.
      const antes = await repo.getPoints({ ...range, asOf: REVISED_RELEASE - DAY });
      expect(antes).toHaveLength(1);
      expect(antes[0]).toMatchObject({ value: 23_100.5, revision: 0 });

      // Una de octubre ya conoce la correccion.
      const despues = await repo.getPoints({ ...range, asOf: REVISED_RELEASE + DAY });
      expect(despues[0]).toMatchObject({ value: 23_050.25, revision: 1 });

      // Sin corte, la ultima conocida.
      expect((await repo.getPoints(range))[0]).toMatchObject({ revision: 1 });
    });

    it('una vela anterior a la primera publicacion no ve el dato, aunque su ts sea pasado', async () => {
      const repo = createMacroRepository(db.pool);
      await repo.upsertPoints({ source: SOURCE, seriesId: SERIES, points: [ORIGINAL, REVISED] });

      const puntos = await repo.getPoints({
        source: SOURCE,
        seriesId: SERIES,
        from: TS - DAY,
        to: TS + DAY,
        asOf: FIRST_RELEASE - DAY,
      });

      expect(puntos).toEqual([]);
    });

    it('reinsertar la misma revision no duplica, y cada serie va por su lado', async () => {
      const repo = createMacroRepository(db.pool);
      await repo.upsertPoints({ source: SOURCE, seriesId: SERIES, points: [ORIGINAL] });

      expect(
        await repo.upsertPoints({ source: SOURCE, seriesId: SERIES, points: [ORIGINAL] }),
      ).toBe(0);
      expect(
        await repo.upsertPoints({ source: SOURCE, seriesId: 'UNRATE', points: [ORIGINAL] }),
      ).toBe(1);
      expect(await repo.upsertPoints({ source: 'eia', seriesId: SERIES, points: [ORIGINAL] })).toBe(
        1,
      );

      expect(await repo.getLastTs({ source: SOURCE, seriesId: SERIES })).toBe(TS);
      expect(await repo.getLastTs({ source: SOURCE, seriesId: 'NO_EXISTE' })).toBeNull();
    });
  });

  describe('dedupe de eventos', () => {
    it('reinsertar el mismo evento no duplica', async () => {
      const repo = createEventsRepository(db.pool);

      expect(await repo.upsertEvents([event()])).toBe(1);
      expect(await repo.upsertEvents([event()])).toBe(0);
      // Releerlo otro dia no lo convierte en otro evento: `fetchedAt` no entra en el hash.
      expect(await repo.upsertEvents([event({ fetchedAt: Date.UTC(2026, 5, 1) })])).toBe(0);

      const stored = await repo.getEvents({ from: 0, to: Date.UTC(2030, 0, 1) });
      expect(stored).toHaveLength(1);
      expect(stored[0]?.payload).toEqual({ titulo: 'Decision de tipos', consenso: 3.75 });
      expect(stored[0]?.assetTags).toEqual(['rates', 'usd']);
      expect(stored[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('el mismo evento con el payload en otro orden de claves es el mismo evento', async () => {
      const repo = createEventsRepository(db.pool);
      await repo.upsertEvents([
        event({ payload: { titulo: 'Decision de tipos', consenso: 3.75 } }),
      ]);

      expect(
        await repo.upsertEvents([
          event({ payload: { consenso: 3.75, titulo: 'Decision de tipos' } }),
        ]),
      ).toBe(0);
    });

    it('un cambio real en el payload si es un evento nuevo', async () => {
      const repo = createEventsRepository(db.pool);
      await repo.upsertEvents([event()]);

      expect(
        await repo.upsertEvents([event({ payload: { titulo: 'Decision de tipos', consenso: 4 } })]),
      ).toBe(1);
      expect(eventContentHash(event())).not.toBe(eventContentHash(event({ type: 'cpi' })));
    });

    it('un lote con el mismo evento dos veces escribe uno', async () => {
      expect(await createEventsRepository(db.pool).upsertEvents([event(), event()])).toBe(1);
    });

    it('filtra por etiqueta y por corte point-in-time', async () => {
      const repo = createEventsRepository(db.pool);
      const petroleo = event({
        type: 'eia-weekly',
        assetTags: ['oil'],
        scheduledAt: Date.UTC(2026, 10, 19, 15, 30, 0),
        fetchedAt: Date.UTC(2026, 10, 1),
        payload: { serie: 'WCESTUS1' },
      });
      await repo.upsertEvents([event(), petroleo]);

      const todos = await repo.getEvents({ from: 0, to: Date.UTC(2030, 0, 1) });
      expect(todos.map((item) => item.type)).toEqual(['eia-weekly', 'fomc']);

      const soloTipos = await repo.getEvents({ from: 0, to: Date.UTC(2030, 0, 1), tags: ['usd'] });
      expect(soloTipos.map((item) => item.type)).toEqual(['fomc']);

      // Lo descargado en noviembre no existia para una vela de enero.
      const enEnero = await repo.getEvents({
        from: 0,
        to: Date.UTC(2030, 0, 1),
        asOf: Date.UTC(2026, 0, 15),
      });
      expect(enEnero.map((item) => item.type)).toEqual(['fomc']);
    });
  });
});
