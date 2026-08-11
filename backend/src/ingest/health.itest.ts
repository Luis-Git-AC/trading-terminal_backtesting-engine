import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { timeframeToMs, type Candle, type Timeframe } from '@tt/shared';
import { runMigrations } from '../db/migrate.js';
import { createCandlesRepository, type CandlesRepository } from '../db/repositories/candles.repo.js';
import { createGapsRepository, type GapsRepository } from '../db/repositories/gaps.repo.js';
import { createScratchDatabase, type ScratchDatabase } from '../testing/scratch-db.js';
import { getIngestHealth } from './health.js';

const SYMBOL = 'HEALTHUSDT';
const MINUTE: Timeframe = '1m';
const HOUR: Timeframe = '1h';
const STEP = timeframeToMs(MINUTE);
const NOW = Date.UTC(2026, 6, 1, 12, 0, 0);

function makeCandle(ts: number): Candle {
  return { t: ts, o: 64_000, h: 64_010, l: 63_990, c: 64_005, v: 1 };
}

describe('getIngestHealth', () => {
  let db: ScratchDatabase;
  let candles: CandlesRepository;
  let gaps: GapsRepository;

  beforeAll(async () => {
    db = await createScratchDatabase({ applicationName: 'tt-itest-health' });
    await runMigrations({ pool: db.pool });
    candles = createCandlesRepository(db.pool);
    gaps = createGapsRepository(db.pool);
  });

  afterAll(async () => {
    await db.drop();
  });

  beforeEach(async () => {
    await db.pool.query('TRUNCATE candles');
    await db.pool.query('TRUNCATE ingest_gaps');
  });

  async function seedLast(ts: number, timeframe: Timeframe = MINUTE): Promise<void> {
    await candles.upsertCandles({
      symbol: SYMBOL,
      timeframe,
      source: 'ws',
      candles: [makeCandle(ts)],
    });
  }

  function check(overrides: Partial<Parameters<typeof getIngestHealth>[0]> = {}) {
    return getIngestHealth({
      pool: db.pool,
      series: [{ symbol: SYMBOL, timeframe: MINUTE }],
      socketState: 'open',
      now: () => NOW,
      ...overrides,
    });
  }

  describe('deteccion de stale', () => {
    it('una vela de hace menos de 2 timeframes no esta stale', async () => {
      await seedLast(NOW - 1.5 * STEP);

      const health = await check();

      expect(health.series[0]).toMatchObject({
        symbol: SYMBOL,
        timeframe: MINUTE,
        lastCandleTs: NOW - 1.5 * STEP,
        lastCandleAgeSec: 90,
        staleAfterSec: 120,
        stale: false,
      });
      expect(health.status).toBe('ok');
      expect(health.staleSeries).toBe(0);
    });

    it('justo en el limite de 2 timeframes todavia no esta stale', async () => {
      await seedLast(NOW - 2 * STEP);

      const health = await check();

      expect(health.series[0]?.lastCandleAgeSec).toBe(120);
      expect(health.series[0]?.stale).toBe(false);
      expect(health.status).toBe('ok');
    });

    it('pasado el limite si esta stale y el estado se degrada', async () => {
      await seedLast(NOW - 2 * STEP - 1000);

      const health = await check();

      expect(health.series[0]?.lastCandleAgeSec).toBe(121);
      expect(health.series[0]?.stale).toBe(true);
      expect(health.staleSeries).toBe(1);
      expect(health.status).toBe('degraded');
    });

    it('una serie sin ninguna vela cuenta como stale', async () => {
      const health = await check();

      expect(health.series[0]).toMatchObject({
        lastCandleTs: null,
        lastCandleAgeSec: null,
        stale: true,
      });
      expect(health.status).toBe('degraded');
    });

    it('el umbral se escala con el timeframe', async () => {
      await seedLast(NOW - 90 * 60_000, HOUR);

      const health = await check({
        series: [{ symbol: SYMBOL, timeframe: HOUR }],
      });

      expect(health.series[0]).toMatchObject({
        timeframe: HOUR,
        staleAfterSec: 7200,
        lastCandleAgeSec: 5400,
        stale: false,
      });
    });

    it('el factor de stale es configurable', async () => {
      await seedLast(NOW - 3 * STEP);

      expect((await check({ staleFactor: 2 })).series[0]?.stale).toBe(true);
      expect((await check({ staleFactor: 4 })).series[0]?.stale).toBe(false);
    });

    it('una vela con ts en el futuro da antiguedad 0, nunca negativa', async () => {
      await seedLast(NOW + 5 * STEP);

      const health = await check();

      expect(health.series[0]?.lastCandleAgeSec).toBe(0);
      expect(health.series[0]?.stale).toBe(false);
    });
  });

  describe('socket y huecos', () => {
    it('el socket cerrado degrada el estado aunque las velas esten al dia', async () => {
      await seedLast(NOW - STEP);

      const health = await check({ socketState: 'closed', reconnects: 3, consecutiveFailures: 3 });

      expect(health.series[0]?.stale).toBe(false);
      expect(health.socketState).toBe('closed');
      expect(health.reconnects).toBe(3);
      expect(health.consecutiveFailures).toBe(3);
      expect(health.status).toBe('degraded');
    });

    it('cuenta los huecos abiertos por serie y en total, sin degradar por ellos', async () => {
      await seedLast(NOW - STEP);
      await gaps.recordGap({
        symbol: SYMBOL,
        timeframe: MINUTE,
        fromTs: NOW - 100 * STEP,
        toTs: NOW - 98 * STEP,
      });
      await gaps.recordGap({
        symbol: SYMBOL,
        timeframe: MINUTE,
        fromTs: NOW - 50 * STEP,
        toTs: NOW - 50 * STEP,
      });

      const health = await check();

      expect(health.series[0]?.openGaps).toBe(2);
      expect(health.openGaps).toBe(2);
      expect(health.status).toBe('ok');
    });

    it('un hueco ya cerrado deja de contar', async () => {
      await seedLast(NOW - STEP);
      const gap = await gaps.recordGap({
        symbol: SYMBOL,
        timeframe: MINUTE,
        fromTs: NOW - 50 * STEP,
        toTs: NOW - 50 * STEP,
      });
      await gaps.markFilled({ id: gap.id, lastError: null });

      expect((await check()).openGaps).toBe(0);
    });
  });

  it('informa de todas las series y basta una stale para degradar', async () => {
    await seedLast(NOW - STEP);
    await seedLast(NOW - 10 * 60 * 60_000, HOUR);

    const health = await check({
      series: [
        { symbol: SYMBOL, timeframe: MINUTE },
        { symbol: SYMBOL, timeframe: HOUR },
      ],
    });

    expect(health.series.map((item) => [item.timeframe, item.stale])).toEqual([
      [MINUTE, false],
      [HOUR, true],
    ]);
    expect(health.staleSeries).toBe(1);
    expect(health.status).toBe('degraded');
    expect(health.checkedAt).toBe(NOW);
  });
});
