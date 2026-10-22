import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import { createDerivativesRepository } from '../db/repositories/derivatives.repo.js';
import { createFakeSocketFactory, type FakeSocketFactory } from '../testing/fake-socket.js';
import { createScratchDatabase, type ScratchDatabase } from '../testing/scratch-db.js';
import { createLogger } from '../observability/logger.js';
import { startIngestor, type IngestorHandle } from '../roles/ingestor.js';
import { collectDerivatives } from './derivatives-collector.js';
import { createRateLimiter } from './rate-limiter.js';
import type { ExchangeAdapter, FetchLike, HttpResponse } from './exchange/adapter.js';
import { createHyperliquidDerivativesClient } from './exchange/hyperliquid/derivatives.js';
import { createHyperliquidCandleStream } from './exchange/hyperliquid/ws.js';

const SYMBOL = 'BTC';

function loadText(name: string): string {
  const url = new URL(`../__fixtures__/hyperliquid/${name}.json`, import.meta.url);
  return readFileSync(url, 'utf8');
}

const FUNDING = JSON.parse(loadText('funding-history-btc')) as unknown;
const META_CTXS = JSON.parse(loadText('meta-and-asset-ctxs-btc')) as unknown;
const WS_ASSET_CTX = loadText('ws-asset-ctx');

/** Responde segun el `type` del cuerpo: el cliente hace dos peticiones distintas a /info. */
const fakeFetch: FetchLike = (_url, init) => {
  const body = JSON.parse(init?.body ?? '{}') as { type?: string };
  const payload = body.type === 'fundingHistory' ? FUNDING : META_CTXS;
  const response: HttpResponse = {
    status: 200,
    headers: { get: () => null },
    json: () => Promise.resolve(payload),
  };
  return Promise.resolve(response);
};

describe('derivados de Hyperliquid contra la base de datos', () => {
  let db: ScratchDatabase;

  beforeAll(async () => {
    db = await createScratchDatabase({ applicationName: 'tt-itest-hyperliquid-derivatives' });
    await runMigrations({ pool: db.pool });
  });

  afterAll(async () => {
    await db.drop();
  });

  beforeEach(async () => {
    await db.pool.query('DELETE FROM funding_rates');
    await db.pool.query('DELETE FROM open_interest');
  });

  it('el funding historico se persiste con interval_hours = 1', async () => {
    const client = createHyperliquidDerivativesClient({ fetch: fakeFetch, rps: 1000 });

    const report = await collectDerivatives({
      pool: db.pool,
      client,
      exchange: 'hyperliquid',
      symbols: [SYMBOL],
    });

    expect(report.funding).toBe(6);
    // Sin OI historico upstream: la unica fila es el ctx actual.
    expect(report.openInterest).toBe(1);

    const { rows } = await db.pool.query<{ interval_hours: number; count: string }>(
      'SELECT interval_hours, count(*)::text AS count FROM funding_rates GROUP BY interval_hours',
    );
    expect(rows).toEqual([{ interval_hours: 1, count: '6' }]);

    const oi = await createDerivativesRepository(db.pool).getOpenInterest({
      exchange: 'hyperliquid',
      symbol: SYMBOL,
      from: 0,
      to: Date.now() + 60_000,
    });
    expect(oi).toHaveLength(1);
    expect(oi[0]?.base).toBe(43446.6771);
    expect(oi[0]?.quote).toBeNull();
  });

  it('repetir la recogida no escribe funding de nuevo', async () => {
    const client = createHyperliquidDerivativesClient({ fetch: fakeFetch, rps: 1000 });
    const options = { pool: db.pool, client, exchange: 'hyperliquid', symbols: [SYMBOL] };

    await collectDerivatives(options);
    const second = await collectDerivatives(options);

    expect(second.funding).toBe(0);
  });

  describe('OI vivo por el socket', () => {
    let handle: IngestorHandle;
    let fakes: FakeSocketFactory;
    let clock: number;

    beforeEach(async () => {
      clock = Date.UTC(2026, 9, 22, 12, 0, 0);
      fakes = createFakeSocketFactory();

      const adapter: ExchangeAdapter = {
        id: 'hyperliquid',
        maxHistoryCandles: 5000,
        maxPageLimit: 5000,
        createRestClient: () => ({
          limiter: createRateLimiter({ rps: 1000 }),
          getHistoryCandles: () => Promise.resolve([]),
        }),
        createCandleStream: () =>
          createHyperliquidCandleStream({
            url: 'ws://local.test',
            createSocket: fakes.factory,
            staleTimeoutMs: 0,
            heartbeatIntervalMs: 0,
            now: () => clock,
          }),
        createDerivativesClient: () => createHyperliquidDerivativesClient({ fetch: fakeFetch }),
        normalizeSymbol: (raw) => raw,
      };

      handle = await startIngestor({
        pool: db.pool,
        publisher: {
          publishCandle: () => Promise.resolve(),
          close: () => Promise.resolve(),
        },
        logger: createLogger({ level: 'silent', role: 'ingestor' }),
        exchanges: [
          {
            exchange: 'hyperliquid',
            adapter,
            feed: { getHistoryCandles: () => Promise.resolve([]) },
            series: [{ symbol: SYMBOL, timeframe: '1m' }],
          },
        ],
        backfillFrom: clock - 60_000,
        metricsIntervalMs: 0,
        signals: [],
        now: () => clock,
      });
    });

    afterAll(async () => {
      // `handle.stop()` cierra el pool, y de ese pool vive el resto del fichero: se para solo la ingesta.
      for (const exchange of handle.exchanges) await exchange.ingestor.stop();
    });

    it('un activeAssetCtx deja una fila de open interest, y la rafaga siguiente no', async () => {
      fakes.last().emitOpen();
      fakes.last().emitMessage(WS_ASSET_CTX);
      await vi.waitFor(async () => {
        expect(await countOi()).toBe(1);
      });

      for (let i = 0; i < 5; i += 1) fakes.last().emitMessage(WS_ASSET_CTX);
      clock += 1000;
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(await countOi()).toBe(1);

      clock += 60_000;
      fakes.last().emitMessage(WS_ASSET_CTX);
      await vi.waitFor(async () => {
        expect(await countOi()).toBe(2);
      });

      const { rows } = await db.pool.query<{ source: string; oi_base: string }>(
        'SELECT source, oi_base FROM open_interest ORDER BY ts',
      );
      expect(rows[0]).toEqual({ source: 'ws', oi_base: '43446.5499600000' });
      expect(fakes.created).toHaveLength(1);
    });

    async function countOi(): Promise<number> {
      const { rows } = await db.pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM open_interest',
      );
      return Number(rows[0]?.count ?? 0);
    }
  });
});
