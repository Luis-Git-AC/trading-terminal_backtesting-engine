import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { timeframeToMs, type Candle, type Timeframe } from '@tt/shared';
import { runMigrations } from '../db/migrate.js';
import { createCandlesRepository, type CandlesRepository } from '../db/repositories/candles.repo.js';
import { createGapsRepository, type GapsRepository } from '../db/repositories/gaps.repo.js';
import {
  createIngestStateRepository,
  type IngestStateRepository,
} from '../db/repositories/ingest-state.repo.js';
import { createCandlePublisher, createRedisClient } from '../queue/pubsub.js';
import { startFakeBitgetWs, type FakeBitgetWs } from '../testing/fake-bitget-ws.js';
import { createScratchDatabase, type ScratchDatabase } from '../testing/scratch-db.js';
import { createBitgetCandleStream } from './exchange/bitget/ws.js';
import { createLiveIngestor, type LiveIngestor } from './live-ingestor.js';
import { reconcileSeries, type ReconcileReport } from './reconcile.js';
import type { CandleFeed, CandleFeedQuery } from './backfill.js';

const SYMBOL = 'RCNUSDT';
const TIMEFRAME: Timeframe = '1m';
const STEP = timeframeToMs(TIMEFRAME);
const START = Date.UTC(2026, 6, 1, 0, 0, 0);

function makeCandle(index: number): Candle {
  const base = 64_000 + index;
  return { t: START + index * STEP, o: base, h: base + 10, l: base - 10, c: base + 5, v: 1 + index };
}

interface RecordingFeed extends CandleFeed {
  calls: CandleFeedQuery[];
}

function createFeed(available: readonly Candle[]): RecordingFeed {
  const ascending = [...available].sort((a, b) => a.t - b.t);
  const feed: RecordingFeed = {
    calls: [],
    async getHistoryCandles(query: CandleFeedQuery): Promise<Candle[]> {
      feed.calls.push(query);
      await Promise.resolve();
      const end = query.endTime ?? Number.POSITIVE_INFINITY;
      const limit = query.limit ?? 200;
      const before = ascending.filter((candle) => candle.t < end);
      return before.slice(Math.max(0, before.length - limit));
    },
  };
  return feed;
}

function requireRedisUrl(): string {
  const url = process.env.REDIS_URL;
  if (url === undefined || url.length === 0) {
    throw new Error('REDIS_URL no esta definida. Copia .env.example a .env y ejecuta npm run db:up.');
  }
  return url;
}

describe('reconcileSeries', () => {
  let db: ScratchDatabase;
  let candles: CandlesRepository;
  let gaps: GapsRepository;
  let state: IngestStateRepository;

  beforeAll(async () => {
    db = await createScratchDatabase({ applicationName: 'tt-itest-reconcile' });
    await runMigrations({ pool: db.pool });
    candles = createCandlesRepository(db.pool);
    gaps = createGapsRepository(db.pool);
    state = createIngestStateRepository(db.pool);
  });

  afterAll(async () => {
    await db.drop();
  });

  beforeEach(async () => {
    await db.pool.query('TRUNCATE candles');
    await db.pool.query('TRUNCATE ingest_gaps');
    await db.pool.query('TRUNCATE ingest_state');
    await state.ensure({ symbol: SYMBOL, timeframe: TIMEFRAME, targetTs: START });
  });

  async function seed(indices: readonly number[], source: 'rest' | 'ws' = 'ws'): Promise<void> {
    await candles.upsertCandles({
      symbol: SYMBOL,
      timeframe: TIMEFRAME,
      source,
      candles: indices.map(makeCandle),
    });
  }

  async function storedIndices(): Promise<number[]> {
    const { rows } = await db.pool.query<{ ts: Date }>(
      'SELECT ts FROM candles WHERE symbol = $1 AND timeframe = $2 ORDER BY ts ASC',
      [SYMBOL, TIMEFRAME],
    );
    return rows.map((row) => (row.ts.getTime() - START) / STEP);
  }

  function reconcile(
    feed: CandleFeed,
    overrides: Partial<Parameters<typeof reconcileSeries>[0]> = {},
  ): Promise<ReconcileReport> {
    return reconcileSeries({
      pool: db.pool,
      feed,
      symbol: SYMBOL,
      timeframe: TIMEFRAME,
      pageLimit: 200,
      maxPages: 10,
      ...overrides,
    });
  }

  describe('casos de borde', () => {
    it('sin ninguna vela en la serie no hay ancla y no pide nada al REST', async () => {
      const feed = createFeed([makeCandle(0)]);
      const report = await reconcile(feed, { to: START + 10 * STEP });

      expect(report.stoppedBy).toBe('no-anchor');
      expect(report.lastCandleTs).toBeNull();
      expect(feed.calls).toEqual([]);
      expect(await storedIndices()).toEqual([]);
    });

    it('con la serie al dia no pide nada al REST', async () => {
      await seed([0, 1, 2]);
      const feed = createFeed(Array.from({ length: 3 }, (_, index) => makeCandle(index)));

      const report = await reconcile(feed, { to: START + 3 * STEP });

      expect(report.stoppedBy).toBe('up-to-date');
      expect(feed.calls).toEqual([]);
    });

    it('el limite superior se alinea al timeframe y deja fuera la vela en formacion', async () => {
      await seed([0]);
      const feed = createFeed(Array.from({ length: 6 }, (_, index) => makeCandle(index)));

      const report = await reconcile(feed, { to: START + 5 * STEP + 30_000 });

      expect(report.upperTs).toBe(START + 5 * STEP);
      expect(await storedIndices()).toEqual([0, 1, 2, 3, 4]);
    });
  });

  describe('relleno del hueco', () => {
    it('recupera por REST las velas que faltan entre la ultima guardada y ahora', async () => {
      await seed([0, 1, 2]);
      const feed = createFeed(Array.from({ length: 20 }, (_, index) => makeCandle(index)));

      const report = await reconcile(feed, { to: START + 20 * STEP });

      expect(report.missingBefore).toBe(17);
      expect(report.stoppedBy).toBe('complete');
      expect(await storedIndices()).toEqual(Array.from({ length: 20 }, (_, index) => index));
      expect(
        await candles.findGaps({ symbol: SYMBOL, timeframe: TIMEFRAME, from: START, to: START + 20 * STEP }),
      ).toEqual([]);
    });

    it('pagina hacia atras cuando el hueco no cabe en una pagina', async () => {
      await seed([0]);
      const feed = createFeed(Array.from({ length: 25 }, (_, index) => makeCandle(index)));

      const report = await reconcile(feed, { to: START + 25 * STEP, pageLimit: 10, maxPages: 10 });

      expect(report.pages).toBe(3);
      expect(await storedIndices()).toEqual(Array.from({ length: 25 }, (_, index) => index));
      expect(feed.calls.map((call) => call.limit)).toEqual([10, 10, 10]);
    });

    it('una pagina vacia corta el bucle sin inventar velas', async () => {
      await seed([0]);
      const feed = createFeed([]);

      const report = await reconcile(feed, { to: START + 10 * STEP });

      expect(report.stoppedBy).toBe('no-more-data');
      expect(report.pages).toBe(1);
      expect(await storedIndices()).toEqual([0]);
    });

    it('solo mira hacia delante desde la ultima vela: los huecos interiores son de F2-T5', async () => {
      await seed([0, 5, 9]);
      const feed = createFeed(Array.from({ length: 12 }, (_, index) => makeCandle(index)));

      const report = await reconcile(feed, { to: START + 12 * STEP });

      expect(report.lastCandleTs).toBe(START + 9 * STEP);
      expect(report.missingBefore).toBe(2);
      expect(await storedIndices()).toEqual([0, 5, 9, 10, 11]);
    });
  });

  describe('hueco demasiado grande', () => {
    it('se registra en ingest_gaps con el rango exacto y no se pide nada al REST', async () => {
      await seed([0]);
      const feed = createFeed(Array.from({ length: 5000 }, (_, index) => makeCandle(index)));

      const report = await reconcile(feed, {
        to: START + 3000 * STEP,
        pageLimit: 100,
        maxPages: 5,
      });

      expect(report.stoppedBy).toBe('gap-too-large');
      expect(report.missingBefore).toBe(2999);
      expect(feed.calls).toEqual([]);

      const open = await gaps.listOpen({ symbol: SYMBOL, timeframe: TIMEFRAME });
      expect(open).toHaveLength(1);
      expect(open[0]).toMatchObject({
        symbol: SYMBOL,
        timeframe: TIMEFRAME,
        fromTs: START + STEP,
        toTs: START + 2999 * STEP,
        filledAt: null,
        attempts: 0,
      });
    });

    it('registrar el mismo hueco dos veces no duplica filas', async () => {
      await seed([0]);
      const feed = createFeed([]);

      await reconcile(feed, { to: START + 3000 * STEP, pageLimit: 100, maxPages: 5 });
      await reconcile(feed, { to: START + 4000 * STEP, pageLimit: 100, maxPages: 5 });

      const open = await gaps.listOpen({ symbol: SYMBOL, timeframe: TIMEFRAME });
      expect(open).toHaveLength(1);
      expect(open[0]?.toTs).toBe(START + 3999 * STEP);
    });

    it('el hueco enorme no impide que la serie siga recibiendo velas nuevas', async () => {
      await seed([0]);
      const feed = createFeed([]);

      await reconcile(feed, { to: START + 3000 * STEP, pageLimit: 100, maxPages: 5 });
      await seed([3000, 3001]);

      expect(await storedIndices()).toEqual([0, 3000, 3001]);
      expect(await gaps.listOpen({ symbol: SYMBOL, timeframe: TIMEFRAME })).toHaveLength(1);
    });
  });

  describe('escritura', () => {
    it('la reconciliacion no reescribe velas identicas ni les cambia ingested_at', async () => {
      await seed([0, 1, 2, 3, 4]);

      const { rows: before } = await db.pool.query<{ ingested_at: Date; source: string }>(
        'SELECT ingested_at, source FROM candles WHERE symbol = $1 ORDER BY ts ASC',
        [SYMBOL],
      );

      const feed = createFeed(Array.from({ length: 5 }, (_, index) => makeCandle(index)));
      const report = await reconcile(feed, { to: START + 5 * STEP });

      expect(report.stoppedBy).toBe('up-to-date');

      await candles.upsertCandles({
        symbol: SYMBOL,
        timeframe: TIMEFRAME,
        source: 'rest',
        candles: Array.from({ length: 5 }, (_, index) => makeCandle(index)),
      });

      const { rows: after } = await db.pool.query<{ ingested_at: Date; source: string }>(
        'SELECT ingested_at, source FROM candles WHERE symbol = $1 ORDER BY ts ASC',
        [SYMBOL],
      );

      expect(after.map((row) => row.ingested_at.getTime())).toEqual(
        before.map((row) => row.ingested_at.getTime()),
      );
      expect(after.every((row) => row.source === 'ws')).toBe(true);
    });

    it('una vela que si cambio se reescribe con el nuevo valor y nuevo ingested_at', async () => {
      await seed([0]);
      const { rows: before } = await db.pool.query<{ ingested_at: Date }>(
        'SELECT ingested_at FROM candles WHERE symbol = $1',
        [SYMBOL],
      );

      const corrected = { ...makeCandle(0), c: 64_009 };
      const affected = await candles.upsertCandles({
        symbol: SYMBOL,
        timeframe: TIMEFRAME,
        source: 'rest',
        candles: [corrected],
      });

      const { rows: after } = await db.pool.query<{ ingested_at: Date; close: string; source: string }>(
        'SELECT ingested_at, close, source FROM candles WHERE symbol = $1',
        [SYMBOL],
      );

      expect(affected).toBe(1);
      expect(Number(after[0]?.close)).toBe(64_009);
      expect(after[0]?.source).toBe('rest');
      expect(after[0]?.ingested_at.getTime()).toBeGreaterThanOrEqual(
        before[0]?.ingested_at.getTime() ?? 0,
      );
    });

    it('es un upsert: las velas que ya estaban sobreviven y conservan su source', async () => {
      await seed([0, 1, 2]);
      const feed = createFeed(Array.from({ length: 10 }, (_, index) => makeCandle(index)));

      await reconcile(feed, { to: START + 10 * STEP });

      expect(await storedIndices()).toEqual(Array.from({ length: 10 }, (_, index) => index));

      const { rows } = await db.pool.query<{ source: string }>(
        'SELECT source FROM candles WHERE symbol = $1 ORDER BY ts ASC',
        [SYMBOL],
      );
      expect(rows.slice(0, 3).map((row) => row.source)).toEqual(['ws', 'ws', 'ws']);
      expect(rows.slice(3).every((row) => row.source === 'rest')).toBe(true);
    });
  });

  describe('DoD: un corte de la conexion no deja huecos', () => {
    let exchange: FakeBitgetWs;
    let ingestor: LiveIngestor | undefined;
    const redisUrl = requireRedisUrl();

    beforeEach(async () => {
      exchange = await startFakeBitgetWs();
      ingestor = undefined;
    });

    afterEach(async () => {
      await ingestor?.stop();
      await exchange.stop();
    });

    it('velas por WS, corte duro, el tiempo avanza sin cliente, reconexion + reconciliacion: 0 huecos', async () => {
      const UPSTREAM = 41;
      const upstream = Array.from({ length: UPSTREAM }, (_, index) => makeCandle(index));
      const feed = createFeed(upstream);

      const stream = createBitgetCandleStream({
        url: exchange.url,
        staleTimeoutMs: 0,
        heartbeatIntervalMs: 0,
        reconnectBaseMs: 20,
        reconnectMaxMs: 60,
        random: () => 1,
        now: () => 0,
      });

      let opens = 0;
      let reconciled: Promise<ReconcileReport> | undefined;
      stream.socket.on((event) => {
        if (event.kind !== 'state' || event.to !== 'open') return;
        opens += 1;
        if (opens > 1) {
          reconciled = reconcile(feed, { to: START + 30 * STEP });
        }
      });

      const created = createLiveIngestor({
        stream,
        candles,
        state,
        publisher: createCandlePublisher({ redis: createRedisClient(redisUrl) }),
        series: [{ symbol: SYMBOL, timeframe: TIMEFRAME }],
        flushIntervalMs: 50,
      });
      ingestor = created;
      created.start();

      await vi.waitFor(() => {
        expect(exchange.subscriptions).toHaveLength(1);
      });

      for (const candle of upstream.slice(0, 11)) {
        exchange.pushCandle(candle, SYMBOL, TIMEFRAME);
      }

      await vi.waitFor(
        async () => {
          expect(await storedIndices()).toEqual(Array.from({ length: 10 }, (_, i) => i));
        },
        { timeout: 10_000 },
      );

      exchange.cutConnections();

      await vi.waitFor(
        () => {
          expect(exchange.connections()).toBe(2);
          expect(exchange.subscriptions).toHaveLength(2);
        },
        { timeout: 10_000 },
      );

      await vi.waitFor(
        () => {
          expect(reconciled).toBeDefined();
        },
        { timeout: 10_000 },
      );
      if (reconciled === undefined) throw new Error('la reconciliacion no llego a lanzarse');
      const report = await reconciled;

      expect(report.lastCandleTs).toBe(START + 9 * STEP);
      expect(report.missingBefore).toBe(20);
      expect(report.stoppedBy).toBe('complete');

      for (const candle of upstream.slice(30)) {
        exchange.pushCandle(candle, SYMBOL, TIMEFRAME);
      }

      await vi.waitFor(
        async () => {
          expect(await storedIndices()).toHaveLength(UPSTREAM - 1);
        },
        { timeout: 10_000 },
      );

      expect(await storedIndices()).toEqual(
        Array.from({ length: UPSTREAM - 1 }, (_, index) => index),
      );
      expect(
        await candles.findGaps({
          symbol: SYMBOL,
          timeframe: TIMEFRAME,
          from: START,
          to: START + UPSTREAM * STEP,
        }),
      ).toEqual([]);
      expect(
        await candles.findDuplicates({
          symbol: SYMBOL,
          timeframe: TIMEFRAME,
          from: START,
          to: START + UPSTREAM * STEP,
        }),
      ).toEqual([]);
    });
  });
});
