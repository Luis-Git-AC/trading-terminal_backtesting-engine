import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { MacroPoint } from '../../db/repositories/macro.repo.js';
import type { UpstreamError } from '../../ingest/exchange/errors.js';
import { createRateLimiter } from '../../ingest/rate-limiter.js';
import type { SourceContext } from '../adapter.js';
import { createCftcClient, MAX_LINE_BYTES, type StreamResponse } from './client.js';
import { createCftcSource, type CftcRaw } from './cftc.source.js';
import { CFTC_REPORT_EVENT_TYPE, publicationInstant, toTimestamp } from './types.js';

const NOW = Date.UTC(2026, 9, 23, 19, 40, 0);
const CONTEXT: SourceContext = { limiter: createRateLimiter({ rps: 1000 }), now: () => NOW };
const URL_INFORME = 'https://www.cftc.gov/dea/newcot/deafut.txt';

const INFORME = readFileSync(
  fileURLToPath(new URL('../../__fixtures__/cftc/deafut-recortado.txt', import.meta.url)),
);

function stream(bytes: Uint8Array, chunkSize = 512): Iterable<Uint8Array> {
  return {
    *[Symbol.iterator]() {
      for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
        yield bytes.subarray(offset, offset + chunkSize);
      }
    },
  };
}

function fakeFetch(response: StreamResponse, urls: string[] = []) {
  return (url: string): Promise<StreamResponse> => {
    urls.push(url);
    return Promise.resolve(response);
  };
}

interface Spy {
  points: { seriesId: string; points: readonly MacroPoint[] }[];
  events: { type: string; assetTags: readonly string[]; payload: Record<string, unknown> }[];
}

function source(options: { response?: StreamResponse; urls?: string[] } = {}) {
  const spy: Spy = { points: [], events: [] };

  return {
    spy,
    adapter: createCftcSource({
      pool: undefined as never,
      client: createCftcClient({
        url: URL_INFORME,
        fetch: fakeFetch(
          options.response ?? { status: 200, body: stream(INFORME) },
          options.urls ?? [],
        ),
      }),
      schedule: '13 20 * * *',
      macroRepo: {
        upsertPoints: ({ seriesId, points }) => {
          spy.points.push({ seriesId, points });
          return Promise.resolve(points.length);
        },
        getPoints: () => Promise.resolve([]),
        getLastTs: () => Promise.resolve(null),
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

describe('desfase del COT', () => {
  it('el informe del martes se publica el viernes a las 15:30 de Nueva York', () => {
    // Martes 2026-10-13 -> viernes 2026-10-16, en horario de verano (UTC-4).
    expect(publicationInstant(toTimestamp('2026-10-13'))).toBe(Date.UTC(2026, 9, 16, 19, 30));
  });

  it('el published_at va tres dias por delante del scheduled_at, no al reves', () => {
    const martes = toTimestamp('2026-10-13');
    const DIA = 24 * 60 * 60 * 1000;

    expect(publicationInstant(martes) - martes).toBeGreaterThan(3 * DIA);
    expect(publicationInstant(martes) - martes).toBeLessThan(4 * DIA);
  });

  it('el cambio de hora de Nueva York mueve la hora UTC, no la local', () => {
    // El horario de verano de 2026 acaba el 1 de noviembre.
    expect(publicationInstant(toTimestamp('2026-11-03'))).toBe(Date.UTC(2026, 10, 6, 20, 30));
  });
});

describe('cliente de la CFTC', () => {
  it('lee el informe por trozos y devuelve una fila por linea', async () => {
    const urls: string[] = [];
    const client = createCftcClient({
      url: URL_INFORME,
      fetch: fakeFetch({ status: 200, body: stream(INFORME, 37) }, urls),
    });

    const lines: string[] = [];
    for await (const line of client.streamLines()) lines.push(line);

    expect(urls).toEqual([URL_INFORME]);
    expect(lines).toHaveLength(5);
    expect(lines[3]?.startsWith('"GOLD - COMMODITY EXCHANGE INC.",261013,2026-10-13,088691')).toBe(
      true,
    );
  });

  it('un 503 se reintenta y un 404 no', async () => {
    const caught = async (status: number): Promise<UpstreamError> => {
      const client = createCftcClient({
        url: URL_INFORME,
        fetch: fakeFetch({ status, body: null }),
      });
      try {
        for await (const _line of client.streamLines()) break;
      } catch (error) {
        return error as UpstreamError;
      }
      throw new Error(`se esperaba un fallo con status ${status}`);
    };

    expect((await caught(503)).retryable).toBe(true);
    expect((await caught(429)).retryable).toBe(true);
    expect((await caught(404)).retryable).toBe(false);
    expect((await caught(404)).message).toContain('la CFTC respondio 404');
  });

  it('una respuesta sin cuerpo no se queda colgada', async () => {
    const client = createCftcClient({
      url: URL_INFORME,
      fetch: fakeFetch({ status: 200, body: null }),
    });

    await expect(async () => {
      for await (const _line of client.streamLines()) break;
    }).rejects.toThrow('sin cuerpo');
  });

  it('un fichero sin saltos de linea no crece sin limite', async () => {
    const enorme = new TextEncoder().encode('x'.repeat(MAX_LINE_BYTES + 1024));
    const client = createCftcClient({
      url: URL_INFORME,
      fetch: fakeFetch({ status: 200, body: stream(enorme, 4096) }),
    });

    await expect(async () => {
      for await (const _line of client.streamLines()) break;
    }).rejects.toThrow(/pasa de \d+ bytes/);
  });
});

describe('lectura del informe de la CFTC', () => {
  it('se queda con los tres mercados seguidos y descarta el resto mientras lee', async () => {
    const raw: CftcRaw = await source().adapter.fetch(null, CONTEXT);

    expect(raw.scanned).toBe(5);
    expect(raw.lines).toHaveLength(3);
    expect(raw.fetchedAt).toBe(NOW);
  });

  it('un nombre con comas dentro de las comillas no descoloca los campos', async () => {
    const { adapter } = source();
    const batch = adapter.normalize(await adapter.fetch(null, CONTEXT));
    const nombres = batch.items
      .filter((item) => item.kind === 'position')
      .map((item) => item.marketName);

    // El ICE ("CRUDE OIL, LIGHT SWEET-WTI - ICE FUTURES EUROPE") lleva coma y no se sigue.
    expect(nombres).toEqual([
      'WTI-PHYSICAL - NEW YORK MERCANTILE EXCHANGE',
      'SILVER - COMMODITY EXCHANGE INC.',
      'GOLD - COMMODITY EXCHANGE INC.',
    ]);
  });

  it('no acumula el fichero en memoria: 24 MB de filas apenas mueven el heap', async () => {
    const encoder = new TextEncoder();
    const fila = encoder.encode(
      `"RELLENO - MERCADO FALSO",261013,2026-10-13,999999,XXX ,01,999 ,${' 1'.repeat(60)}\n`,
    );
    const objetivo = 24 * 1024 * 1024;
    const repeticiones = Math.ceil(objetivo / fila.byteLength);

    const client = createCftcClient({
      url: URL_INFORME,
      fetch: () =>
        Promise.resolve({
          status: 200,
          body: {
            *[Symbol.iterator]() {
              // Generado al vuelo: ni el test tiene el fichero entero en memoria.
              for (let i = 0; i < repeticiones; i += 1) yield fila;
            },
          },
        }),
    });

    const antes = process.memoryUsage().heapUsed;
    let leidas = 0;
    for await (const _line of client.streamLines()) leidas += 1;
    const crecimiento = process.memoryUsage().heapUsed - antes;

    expect(leidas).toBe(repeticiones);
    expect(fila.byteLength * repeticiones).toBeGreaterThan(objetivo);
    // Una implementacion que concatenase el fichero pasaria de 24 MB (48 en UTF-16); esta se
    // queda en el trozo que esta decodificando.
    expect(crecimiento).toBeLessThan(8 * 1024 * 1024);
  });
});

describe('normalizado de la CFTC', () => {
  async function normalized() {
    const built = source();
    const raw = await built.adapter.fetch(null, CONTEXT);
    return { built, batch: built.adapter.normalize(raw) };
  }

  it('el neto no comercial es largas menos cortas, con sus dos fechas', async () => {
    const { batch } = await normalized();
    const posiciones = batch.items.filter((item) => item.kind === 'position');

    expect(posiciones).toHaveLength(3);
    expect(posiciones).toContainEqual(
      expect.objectContaining({
        seriesId: 'gold-net-noncommercial',
        t: Date.UTC(2026, 9, 13),
        value: 207_879,
        openInterest: 396_345,
        publishedAt: Date.UTC(2026, 9, 16, 19, 30),
        fetchedAt: NOW,
      }),
    );
    expect(posiciones.map((item) => item.value)).toEqual([100_343, 22_631, 207_879]);
  });

  it('las filas que no interesan cuentan como descartadas', async () => {
    const { batch } = await normalized();

    expect(batch.discarded).toBe(2);
  });

  it('el informe deja un solo evento, con el martes y el viernes', async () => {
    const { batch } = await normalized();
    const informes = batch.items.filter((item) => item.kind === 'report');

    expect(informes).toEqual([
      expect.objectContaining({
        reportDate: '2026-10-13',
        scheduledAt: Date.UTC(2026, 9, 13),
        publishedAt: Date.UTC(2026, 9, 16, 19, 30),
        fetchedAt: NOW,
      }),
    ]);
  });

  it('una fila del formato cambiado revienta en vez de escribir un neto inventado', async () => {
    const { built } = await normalized();
    const raw: CftcRaw = {
      fetchedAt: NOW,
      scanned: 1,
      lines: ['"GOLD - COMMODITY EXCHANGE INC.",261013,2026-10-13,088691,CMX ,01,088 ,  396345'],
    };

    expect(() => built.adapter.normalize(raw)).toThrow();
  });

  it('una fila sin el nombre entre comillas tampoco pasa en silencio', async () => {
    const { built } = await normalized();

    expect(() =>
      built.adapter.normalize({ fetchedAt: NOW, scanned: 1, lines: ['GOLD,261013,2026-10-13'] }),
    ).toThrow(/ilegible/);
  });
});

describe('persistencia de la CFTC', () => {
  it('cada mercado va a su serie y el informe a eventos', async () => {
    const built = source();
    const batch = built.adapter.normalize(await built.adapter.fetch(null, CONTEXT));

    const result = await built.adapter.persist(batch);

    expect(built.spy.points.map((entry) => entry.seriesId)).toEqual([
      'wti-net-noncommercial',
      'silver-net-noncommercial',
      'gold-net-noncommercial',
    ]);
    expect(built.spy.points.every((entry) => entry.points.every((point) => point.revision === 0))).toBe(
      true,
    );
    expect(built.spy.events).toEqual([
      {
        type: CFTC_REPORT_EVENT_TYPE,
        assetTags: ['gold', 'silver', 'oil'],
        payload: { report: 'legacy-futures-only', reportDate: '2026-10-13' },
      },
    ]);
    expect(result).toEqual({ written: 4, skipped: 0 });
  });
});
