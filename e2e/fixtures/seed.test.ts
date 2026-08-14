import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { timeframeToMs, type Candle } from '@tt/shared';
import type {
  CandlesRepository,
  UpsertCandlesInput,
} from '../../backend/src/db/repositories/candles.repo.js';
import {
  FIXTURE_PATH,
  FixtureError,
  loadCandleFixture,
  parseCandleFixture,
  seedFixture,
  type CandleFixture,
} from './seed.js';

function rawFixture(): Record<string, unknown> {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Record<string, unknown>;
}

interface FakeRepo {
  readonly repo: CandlesRepository;
  readonly calls: UpsertCandlesInput[];
  readonly stored: Map<string, Candle>;
}

function fakeRepository(): FakeRepo {
  const calls: UpsertCandlesInput[] = [];
  const stored = new Map<string, Candle>();

  const repo = {
    async upsertCandles(input: UpsertCandlesInput): Promise<number> {
      calls.push(input);
      let written = 0;
      for (const candle of input.candles) {
        const key = `${input.symbol}:${input.timeframe}:${candle.t}`;
        const previous = stored.get(key);
        if (previous === undefined || JSON.stringify(previous) !== JSON.stringify(candle)) {
          stored.set(key, candle);
          written += 1;
        }
      }
      return Promise.resolve(written);
    },
    getCandles: () => Promise.resolve([]),
    getCoverage: () => Promise.resolve({ fromTs: null, toTs: null, rows: 0 }),
    findGaps: () => Promise.resolve([]),
    findDuplicates: () => Promise.resolve([]),
    getLastCandleTs: () => Promise.resolve(null),
  } satisfies CandlesRepository;

  return { repo, calls, stored };
}

describe('fixture de velas del E2E', () => {
  const fixture = loadCandleFixture();

  it('carga y valida el fichero commiteado', () => {
    expect(fixture.exchange).toBe('bitget');
    expect(fixture.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(fixture.series).toHaveLength(2);
  });

  it('trae las dos series que pide el ticket: ~2.000 de 15m y ~5.000 de 1m', () => {
    const bars = Object.fromEntries(
      fixture.series.map((series) => [series.timeframe, series.candles.length]),
    );

    expect(bars).toEqual({ '15m': 2000, '1m': 5000 });
  });

  it('las dos series son de BTCUSDT y terminan en el mismo instante', () => {
    const symbols = new Set(fixture.series.map((series) => series.symbol));
    expect([...symbols]).toEqual(['BTCUSDT']);

    const ends = fixture.series.map((series) => series.candles.at(-1)?.t);
    expect(new Set(ends).size).toBe(1);
    expect(new Date(ends[0] ?? 0).toISOString()).toBe('2026-07-21T19:45:00.000Z');
  });

  it('cada serie es contigua, alineada y sin velas incoherentes', () => {
    for (const series of fixture.series) {
      const step = timeframeToMs(series.timeframe);

      for (const [index, candle] of series.candles.entries()) {
        expect(candle.t % step).toBe(0);
        expect(candle.h).toBeGreaterThanOrEqual(Math.max(candle.o, candle.c));
        expect(candle.l).toBeLessThanOrEqual(Math.min(candle.o, candle.c));
        expect(candle.v).toBeGreaterThanOrEqual(0);

        if (index > 0) {
          expect(candle.t - (series.candles[index - 1]?.t ?? 0)).toBe(step);
        }
      }
    }
  });

  it('los precios estan en el rango real de BTCUSDT, no son sinteticos de laboratorio', () => {
    const closes = fixture.series.flatMap((series) => series.candles.map((candle) => candle.c));
    expect(Math.min(...closes)).toBeGreaterThan(1000);
    expect(new Set(closes).size).toBeGreaterThan(closes.length / 2);
  });
});

describe('parseCandleFixture', () => {
  it('rechaza un fixture con un hueco en la serie', () => {
    const raw = rawFixture();
    const series = (raw.series as { bars: number; candles: number[][] }[])[0];
    series?.candles.splice(10, 1);
    if (series !== undefined) series.bars -= 1;

    expect(() => parseCandleFixture(raw)).toThrow(FixtureError);
    expect(() => parseCandleFixture(raw)).toThrow(/hueco entre/);
  });

  it('rechaza un fixture cuyo bars no coincide con las velas', () => {
    const raw = rawFixture();
    const series = (raw.series as { bars: number }[])[0];
    if (series !== undefined) series.bars = 1999;

    expect(() => parseCandleFixture(raw)).toThrow(/declara 1999 velas y trae 2000/);
  });

  it('rechaza un stepMs que no corresponde al timeframe', () => {
    const raw = rawFixture();
    const series = (raw.series as { stepMs: number }[])[0];
    if (series !== undefined) series.stepMs = 60_000;

    expect(() => parseCandleFixture(raw)).toThrow(/stepMs 60000 no corresponde al timeframe/);
  });

  it('rechaza una vela con high por debajo del close', () => {
    const raw = rawFixture();
    const series = (raw.series as { candles: number[][] }[])[0];
    const candle = series?.candles[0];
    if (candle !== undefined) candle[2] = 1;

    expect(() => parseCandleFixture(raw)).toThrow(/high no es el maximo/);
  });

  it('rechaza un ts desalineado', () => {
    const raw = rawFixture();
    const series = (raw.series as { candles: number[][] }[])[0];
    const candle = series?.candles[0];
    if (candle !== undefined) candle[0] = (candle[0] ?? 0) + 1;

    expect(() => parseCandleFixture(raw)).toThrow(/no esta alineado al timeframe/);
  });

  it('rechaza un exchange que no es bitget', () => {
    const raw = rawFixture();
    raw.exchange = 'binance';

    expect(() => parseCandleFixture(raw)).toThrow();
  });
});

describe('seedFixture', () => {
  const fixture: CandleFixture = loadCandleFixture();

  it('escribe las 7.000 velas del fixture con el exchange y el source correctos', async () => {
    const { repo, calls } = fakeRepository();
    const results = await seedFixture({ candles: repo, fixture });

    expect(results.map((r) => r.written)).toEqual([2000, 5000]);
    expect(calls.map((call) => [call.exchange, call.source])).toEqual([
      ['bitget', 'rest'],
      ['bitget', 'rest'],
    ]);
  });

  it('es idempotente: la segunda pasada no escribe nada', async () => {
    const { repo } = fakeRepository();

    const first = await seedFixture({ candles: repo, fixture });
    const second = await seedFixture({ candles: repo, fixture });

    expect(first.reduce((total, r) => total + r.written, 0)).toBe(7000);
    expect(second.reduce((total, r) => total + r.written, 0)).toBe(0);
  });

  it('es determinista: dos cargas del fichero producen las mismas velas', () => {
    const a = loadCandleFixture();
    const b = loadCandleFixture();

    expect(JSON.stringify(a.series)).toBe(JSON.stringify(b.series));
  });

  it('informa del rango real de cada serie', async () => {
    const { repo } = fakeRepository();
    const results = await seedFixture({ candles: repo, fixture });

    expect(results.map((r) => new Date(r.fromTs).toISOString())).toEqual([
      '2026-07-01T00:00:00.000Z',
      '2026-07-18T08:26:00.000Z',
    ]);
    expect(new Set(results.map((r) => r.toTs)).size).toBe(1);
  });
});
