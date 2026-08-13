import { describe, expect, it } from 'vitest';
import { alignTs, timeframeToMs, type Candle } from '@tt/shared';
import type {
  CandlesRepository,
  Coverage,
  DuplicateKey,
  Gap,
  GetCandlesQuery,
  SeriesRef,
  UpsertCandlesInput,
} from './repositories/candles.repo.js';
import { DEFAULT_SEED_BARS, seedSeries } from './seed.js';

const FROM = alignTs(Date.parse('2026-01-01T00:00:00.000Z'), '1h');

function fakeCandlesRepository(writtenOverride?: (input: UpsertCandlesInput) => number): {
  repo: CandlesRepository;
  calls: UpsertCandlesInput[];
} {
  const calls: UpsertCandlesInput[] = [];

  const repo: CandlesRepository = {
    upsertCandles(input: UpsertCandlesInput): Promise<number> {
      calls.push(input);
      return Promise.resolve(writtenOverride?.(input) ?? input.candles.length);
    },
    getCandles(_query: GetCandlesQuery): Promise<Candle[]> {
      return Promise.resolve([]);
    },
    getCoverage(_series: SeriesRef): Promise<Coverage> {
      return Promise.resolve({ fromTs: null, toTs: null, rows: 0 });
    },
    findGaps(_query: {
      symbol: string;
      timeframe: SeriesRef['timeframe'];
      from: number;
      to: number;
    }): Promise<Gap[]> {
      return Promise.resolve([]);
    },
    findDuplicates(_query: {
      symbol: string;
      timeframe: SeriesRef['timeframe'];
      from: number;
      to: number;
    }): Promise<DuplicateKey[]> {
      return Promise.resolve([]);
    },
    getLastCandleTs(_series: SeriesRef): Promise<number | null> {
      return Promise.resolve(null);
    },
  };

  return { repo, calls };
}

describe('seedSeries', () => {
  it('genera y escribe exactamente los bars pedidos cuando caben antes del cierre', async () => {
    const { repo, calls } = fakeCandlesRepository();
    const step = timeframeToMs('1h');

    const report = await seedSeries({
      candles: repo,
      symbol: 'BTCUSDT',
      timeframe: '1h',
      from: FROM,
      bars: 100,
      seed: 1,
      closedBoundary: FROM + 1000 * step,
    });

    expect(report.generated).toBe(100);
    expect(report.written).toBe(100);
    expect(report.requestedBars).toBe(100);
    expect(report.toTs).toBe(FROM + 100 * step);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.source).toBe('synthetic');
    expect(calls[0]!.candles).toHaveLength(100);
  });

  it('recorta a lo que cabe antes de la ultima vela cerrada', async () => {
    const { repo } = fakeCandlesRepository();
    const step = timeframeToMs('1h');

    const report = await seedSeries({
      candles: repo,
      symbol: 'BTCUSDT',
      timeframe: '1h',
      from: FROM,
      bars: DEFAULT_SEED_BARS,
      seed: 1,
      closedBoundary: FROM + 9 * step,
    });

    expect(report.generated).toBe(10);
    expect(report.requestedBars).toBe(DEFAULT_SEED_BARS);
  });

  it('si el limite de cierre esta antes de `from`, no genera nada y no llama al repositorio', async () => {
    const { repo, calls } = fakeCandlesRepository();
    const step = timeframeToMs('1h');

    const report = await seedSeries({
      candles: repo,
      symbol: 'BTCUSDT',
      timeframe: '1h',
      from: FROM,
      bars: 10,
      seed: 1,
      closedBoundary: FROM - step,
    });

    expect(report.generated).toBe(0);
    expect(report.written).toBe(0);
    expect(report.toTs).toBe(FROM);
    expect(calls).toHaveLength(0);
  });

  it('written puede ser menor que generated cuando el upsert no toca filas identicas', async () => {
    const { repo } = fakeCandlesRepository(() => 0);

    const report = await seedSeries({
      candles: repo,
      symbol: 'BTCUSDT',
      timeframe: '1h',
      from: FROM,
      bars: 20,
      seed: 1,
      closedBoundary: FROM + 1000 * timeframeToMs('1h'),
    });

    expect(report.generated).toBe(20);
    expect(report.written).toBe(0);
  });

  it('el reporte queda ligado al symbol, timeframe y seed pedidos', async () => {
    const { repo } = fakeCandlesRepository();

    const report = await seedSeries({
      candles: repo,
      symbol: 'ETHUSDT',
      timeframe: '15m',
      from: alignTs(FROM, '15m'),
      bars: 5,
      seed: 99,
      closedBoundary: FROM + 1000 * timeframeToMs('15m'),
    });

    expect(report.symbol).toBe('ETHUSDT');
    expect(report.timeframe).toBe('15m');
    expect(report.seed).toBe(99);
  });
});
