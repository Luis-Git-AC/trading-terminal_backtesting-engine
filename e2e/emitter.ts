import { z } from 'zod';
import { timeframeSchema, timeframeToMs, type Candle, type Timeframe } from '@tt/shared';
import { env } from '../backend/src/config/env.js';
import { createPool } from '../backend/src/db/pool.js';
import { createCandlesRepository } from '../backend/src/db/repositories/candles.repo.js';
import { makeSyntheticCandles } from '../backend/src/db/synthetic-candles.js';
import { round10 } from '../backend/src/engine/num.js';
import { createCandlePublisher, createRedisClient } from '../backend/src/queue/pubsub.js';
import { loadCandleFixture, type CandleFixture, type FixtureSeries } from './fixtures/seed.js';
import { waitFor } from './wait.js';

export const SCHEMA_TIMEOUT_MS = 120_000;

const optionsSchema = z.object({
  timeframe: timeframeSchema.prefault('1m'),
  intervalMs: z.coerce.number().int().min(50).max(600_000).prefault('1000'),
  formingTicks: z.coerce.number().int().min(0).max(20).prefault('2'),
  bars: z.coerce.number().int().min(1).max(100_000).prefault('2000'),
  seed: z.coerce.number().int().prefault('20260814'),
});

export type EmitterOptions = z.infer<typeof optionsSchema>;

export function readEmitterOptions(source: NodeJS.ProcessEnv): EmitterOptions {
  return optionsSchema.parse({
    timeframe: source.E2E_EMIT_TIMEFRAME,
    intervalMs: source.E2E_EMIT_INTERVAL_MS,
    formingTicks: source.E2E_EMIT_FORMING_TICKS,
    bars: source.E2E_EMIT_BARS,
    seed: source.E2E_EMIT_SEED,
  });
}

export function seriesOf(fixture: CandleFixture, timeframe: Timeframe): FixtureSeries {
  const series = fixture.series.find((entry) => entry.timeframe === timeframe);
  if (series === undefined) {
    throw new Error(`el fixture no trae ninguna serie de ${timeframe}`);
  }
  return series;
}

export interface PlanEmissionInput {
  readonly series: FixtureSeries;
  readonly bars: number;
  readonly seed: number;
}

export function planEmission(input: PlanEmissionInput): Candle[] {
  const last = input.series.candles.at(-1);
  if (last === undefined) {
    throw new Error(`la serie de ${input.series.timeframe} del fixture esta vacia`);
  }

  return makeSyntheticCandles({
    symbol: input.series.symbol,
    timeframe: input.series.timeframe,
    bars: input.bars,
    seed: input.seed,
    from: last.t + timeframeToMs(input.series.timeframe),
    startPrice: last.c,
    volPerBar: 0.0015,
    baseVolume: last.v,
  });
}

export function formingTicks(candle: Candle, steps: number): Candle[] {
  if (steps <= 0) return [];

  const ticks: Candle[] = [];

  for (let i = 1; i <= steps; i += 1) {
    const progress = i / (steps + 1);
    const c = round10(candle.o + (candle.c - candle.o) * progress);
    const h = round10(Math.max(candle.o, c, candle.o + (candle.h - candle.o) * progress));
    const l = round10(Math.min(candle.o, c, candle.o - (candle.o - candle.l) * progress));

    ticks.push({ t: candle.t, o: candle.o, h, l, c, v: round10(candle.v * progress) });
  }

  return ticks;
}

export interface RunEmitterInput {
  readonly plan: readonly Candle[];
  readonly intervalMs: number;
  readonly formingTicks: number;
  readonly publish: (candle: Candle, closed: boolean) => Promise<void>;
  readonly persist: (candle: Candle) => Promise<void>;
  readonly wait: (ms: number) => Promise<void>;
  readonly onCandle?: ((candle: Candle) => void) | undefined;
  readonly shouldStop?: (() => boolean) | undefined;
}

export async function runEmitter(input: RunEmitterInput): Promise<number> {
  const slice = input.intervalMs / (input.formingTicks + 1);
  let emitted = 0;

  for (const candle of input.plan) {
    if (input.shouldStop?.() === true) break;

    for (const tick of formingTicks(candle, input.formingTicks)) {
      await input.wait(slice);
      await input.publish(tick, false);
    }

    await input.wait(slice);
    await input.persist(candle);
    await input.publish(candle, true);

    emitted += 1;
    input.onCandle?.(candle);
  }

  return emitted;
}

export async function startEmitter(): Promise<void> {
  const options = readEmitterOptions(process.env);
  const fixture = loadCandleFixture();
  const series = seriesOf(fixture, options.timeframe);

  const pool = createPool();
  const candles = createCandlesRepository(pool);
  const redis = createRedisClient(env.REDIS_URL);
  const publisher = createCandlePublisher({ redis });

  const ready = await waitFor(
    async () => {
      const { rows } = await pool.query<{ ok: boolean }>(
        "SELECT to_regclass('public.candles') IS NOT NULL AS ok",
      );
      return rows[0]?.ok === true ? true : undefined;
    },
    { label: 'la tabla candles', timeoutMs: SCHEMA_TIMEOUT_MS },
  );
  console.log(`[emitter] esquema listo en ${ready.elapsedMs} ms`);

  const lastTs = await candles.getLastCandleTs({
    exchange: fixture.exchange,
    symbol: series.symbol,
    timeframe: options.timeframe,
  });

  const plan = planEmission({ series, bars: options.bars, seed: options.seed }).filter(
    (candle) => lastTs === null || candle.t > lastTs,
  );

  console.log(
    `[emitter] ${series.symbol} ${options.timeframe}: ${plan.length} vela(s) planificadas, ` +
      `1 cada ${options.intervalMs} ms con ${options.formingTicks} tick(s) en formacion. ` +
      `Sin red hacia el exchange.`,
  );

  let stopping = false;
  const stop = (): void => {
    stopping = true;
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);

  const emitted = await runEmitter({
    plan,
    intervalMs: options.intervalMs,
    formingTicks: options.formingTicks,
    shouldStop: () => stopping,
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    publish: (candle, closed) =>
      publisher.publishCandle(series.symbol, options.timeframe, candle, closed),
    persist: async (candle) => {
      await candles.upsertCandles({
        exchange: fixture.exchange,
        symbol: series.symbol,
        timeframe: options.timeframe,
        source: 'synthetic',
        candles: [candle],
      });
    },
  });

  console.log(`[emitter] ${emitted} vela(s) cerradas emitidas, terminando`);
  await publisher.close();
  await pool.end();
}
