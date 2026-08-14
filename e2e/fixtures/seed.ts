import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { alignTs, timeframeSchema, timeframeToMs, type Candle, type Timeframe } from '@tt/shared';
import type { CandlesRepository } from '../../backend/src/db/repositories/candles.repo.js';

export const FIXTURE_PATH = fileURLToPath(new URL('./candles.json', import.meta.url));

const candleTupleSchema = z.tuple([
  z.number().int(),
  z.number().positive(),
  z.number().positive(),
  z.number().positive(),
  z.number().positive(),
  z.number().nonnegative(),
]);

const seriesSchema = z.object({
  symbol: z.string().min(1),
  timeframe: timeframeSchema,
  stepMs: z.number().int().positive(),
  bars: z.number().int().positive(),
  candles: z.array(candleTupleSchema).min(1),
});

export const fixtureSchema = z.object({
  exchange: z.literal('bitget'),
  capturedAt: z.string().min(1),
  origin: z.string().min(1),
  columns: z.tuple([
    z.literal('t'),
    z.literal('o'),
    z.literal('h'),
    z.literal('l'),
    z.literal('c'),
    z.literal('v'),
  ]),
  series: z.array(seriesSchema).min(1),
});

export type RawFixture = z.infer<typeof fixtureSchema>;

export interface FixtureSeries {
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly stepMs: number;
  readonly candles: readonly Candle[];
}

export interface CandleFixture {
  readonly exchange: 'bitget';
  readonly capturedAt: string;
  readonly origin: string;
  readonly series: readonly FixtureSeries[];
}

export class FixtureError extends Error {}

function toCandles(series: RawFixture['series'][number]): Candle[] {
  return series.candles.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
}

function assertSeriesIsSound(series: FixtureSeries, declaredBars: number): void {
  const label = `${series.symbol} ${series.timeframe}`;
  const step = timeframeToMs(series.timeframe);

  if (series.stepMs !== step) {
    throw new FixtureError(
      `${label}: stepMs ${series.stepMs} no corresponde al timeframe (${step})`,
    );
  }

  if (series.candles.length !== declaredBars) {
    throw new FixtureError(
      `${label}: declara ${declaredBars} velas y trae ${series.candles.length}`,
    );
  }

  let previous: Candle | undefined;
  for (const candle of series.candles) {
    if (alignTs(candle.t, series.timeframe) !== candle.t) {
      throw new FixtureError(`${label}: ts ${candle.t} no esta alineado al timeframe`);
    }
    if (candle.h < candle.l || candle.h < candle.o || candle.h < candle.c) {
      throw new FixtureError(`${label}: vela incoherente en ts ${candle.t} (high no es el maximo)`);
    }
    if (candle.l > candle.o || candle.l > candle.c) {
      throw new FixtureError(`${label}: vela incoherente en ts ${candle.t} (low no es el minimo)`);
    }
    if (previous !== undefined && candle.t - previous.t !== step) {
      throw new FixtureError(
        `${label}: hueco entre ${previous.t} y ${candle.t}; la serie debe ser contigua`,
      );
    }
    previous = candle;
  }
}

export function parseCandleFixture(raw: unknown): CandleFixture {
  const parsed = fixtureSchema.parse(raw);

  const series = parsed.series.map((entry) => {
    const built: FixtureSeries = {
      symbol: entry.symbol,
      timeframe: entry.timeframe,
      stepMs: entry.stepMs,
      candles: toCandles(entry),
    };
    assertSeriesIsSound(built, entry.bars);
    return built;
  });

  return {
    exchange: parsed.exchange,
    capturedAt: parsed.capturedAt,
    origin: parsed.origin,
    series,
  };
}

export function loadCandleFixture(path: string = FIXTURE_PATH): CandleFixture {
  return parseCandleFixture(JSON.parse(readFileSync(path, 'utf8')));
}

export interface SeedSeriesResult {
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly bars: number;
  readonly written: number;
  readonly fromTs: number;
  readonly toTs: number;
}

export interface SeedFixtureOptions {
  readonly candles: CandlesRepository;
  readonly fixture?: CandleFixture;
}

export async function seedFixture(options: SeedFixtureOptions): Promise<SeedSeriesResult[]> {
  const fixture = options.fixture ?? loadCandleFixture();
  const results: SeedSeriesResult[] = [];

  for (const series of fixture.series) {
    const written = await options.candles.upsertCandles({
      exchange: fixture.exchange,
      symbol: series.symbol,
      timeframe: series.timeframe,
      source: 'rest',
      candles: series.candles,
    });

    const first = series.candles.at(0);
    const last = series.candles.at(-1);
    if (first === undefined || last === undefined) {
      throw new FixtureError(`${series.symbol} ${series.timeframe}: serie vacia`);
    }

    results.push({
      symbol: series.symbol,
      timeframe: series.timeframe,
      bars: series.candles.length,
      written,
      fromTs: first.t,
      toTs: last.t,
    });
  }

  return results;
}
