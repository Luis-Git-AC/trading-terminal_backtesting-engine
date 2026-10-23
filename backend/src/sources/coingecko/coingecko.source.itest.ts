import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../../db/migrate.js';
import { createMacroRepository } from '../../db/repositories/macro.repo.js';
import type { FetchLike } from '../../ingest/exchange/adapter.js';
import { createRateLimiter } from '../../ingest/rate-limiter.js';
import { createLogger } from '../../observability/logger.js';
import { createQueueConnection } from '../../queue/connection.js';
import { startCollector, type CollectorHandle } from '../../roles/collector.js';
import { createScratchDatabase, type ScratchDatabase } from '../../testing/scratch-db.js';
import { toRunnable, type SourceRunReport } from '../adapter.js';
import { buildSourceRegistry } from '../registry.js';
import {
  COINGECKO_SOURCE_ID,
  createCoingeckoClient,
  createCoingeckoSource,
  MARKET_CAP_SERIES_ID,
} from './coingecko.source.js';

const NOW = Date.UTC(2026, 9, 23, 6, 11, 0);
const ACTUALIZADO = 1_792_723_404_000;
const SCHEDULE = '31 5 * * *';

function fixture(name: string): unknown {
  const path = fileURLToPath(new URL(`../../__fixtures__/coingecko/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

const GLOBAL = fixture('global');
const ERROR_429 = fixture('error-429');

/** Sin red: el fixture real, o el 429 del tier gratuito. */
function fakeFetch(body: unknown, status = 200): FetchLike {
  return () => Promise.resolve({ status, headers: new Headers(), json: () => Promise.resolve(body) });
}

function requireRedisUrl(): string {
  const url = process.env.REDIS_URL;
  if (url === undefined || url === '') {
    throw new Error('REDIS_URL no esta definida. Copia .env.example a .env y ejecuta npm run db:up.');
  }
  return url;
}

describe('fuente CoinGecko contra la base de datos', () => {
  const redisUrl = requireRedisUrl();
  let db: ScratchDatabase;
  let redis: Redis;
  let handle: CollectorHandle | undefined;

  beforeAll(async () => {
    db = await createScratchDatabase({ applicationName: 'tt-itest-coingecko' });
    await runMigrations({ pool: db.pool });
    redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  });

  afterAll(async () => {
    const leftovers = await redis.keys('tt-itest-coingecko-*');
    if (leftovers.length > 0) await redis.del(...leftovers);
    await redis.quit();
    await db.drop();
  });

  afterEach(async () => {
    await handle?.stop();
    handle = undefined;
    await db.pool.query('DELETE FROM macro_series');
  });

  function source(options: { body?: unknown; status?: number; onRateLimited?: (detail: string) => void } = {}) {
    return createCoingeckoSource({
      pool: db.pool,
      schedule: SCHEDULE,
      client: createCoingeckoClient({
        baseUrl: 'https://api.coingecko.com',
        fetch: fakeFetch(options.body ?? GLOBAL, options.status ?? 200),
        ...(options.onRateLimited === undefined ? {} : { onRateLimited: options.onRateLimited }),
      }),
    });
  }

  function run(now = NOW): Promise<SourceRunReport> {
    return toRunnable(source()).run(null, {
      limiter: createRateLimiter({ rps: 1000 }),
      now: () => now,
    });
  }

  it('persiste el market cap y las dominancias con el updated_at de CoinGecko', async () => {
    const report = await run();

    expect(report).toMatchObject({ sourceId: COINGECKO_SOURCE_ID, items: 3, written: 3 });

    const puntos = await createMacroRepository(db.pool).getPoints({
      source: COINGECKO_SOURCE_ID,
      seriesId: MARKET_CAP_SERIES_ID,
      from: ACTUALIZADO - 1000,
      to: ACTUALIZADO + 1000,
    });

    expect(puntos).toEqual([
      {
        t: ACTUALIZADO,
        value: 2_754_744_296_664.292,
        publishedAt: ACTUALIZADO,
        fetchedAt: NOW,
        revision: 0,
      },
    ]);

    const { rows } = await db.pool.query<{ series_id: string }>(
      'SELECT series_id FROM macro_series ORDER BY series_id',
    );
    expect(rows.map((row) => row.series_id)).toEqual([
      'crypto-total-market-cap-usd',
      'dominance-btc',
      'dominance-eth',
    ]);
  });

  it('una segunda pasada con la misma foto no duplica filas', async () => {
    await run();
    const segunda = await run(NOW + 60_000);

    expect(segunda).toMatchObject({ items: 3, written: 0, skipped: 3 });

    const { rows } = await db.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM macro_series',
    );
    expect(rows[0]?.count).toBe('3');
  });

  it('un 429 reprograma el job y el proceso sigue vivo', async () => {
    const avisos: string[] = [];
    const prefix = `tt-itest-coingecko-${randomUUID().slice(0, 8)}`;

    handle = await startCollector({
      pool: db.pool,
      connection: createQueueConnection(redisUrl),
      redis: new Redis(redisUrl, { maxRetriesPerRequest: null, keyPrefix: `${prefix}:` }),
      logger: createLogger({ role: 'collector', level: 'silent' }),
      registry: buildSourceRegistry({
        candidates: [
          toRunnable(source({ body: ERROR_429, status: 429, onRateLimited: (d) => avisos.push(d) })),
        ],
        env: {},
      }),
      prefix,
      closePool: false,
      signals: [],
    });

    const job = await handle.queue.add(
      'collector',
      { sourceId: COINGECKO_SOURCE_ID },
      { attempts: 3, backoff: { type: 'fixed', delay: 30_000 } },
    );

    await vi.waitFor(
      async () => {
        // Reprogramado, no fallido: le quedan intentos y espera su backoff.
        expect(await job.getState()).toBe('delayed');
      },
      { timeout: 10_000 },
    );

    expect(await handle.queue.getFailed()).toEqual([]);
    expect(handle.worker.isRunning()).toBe(true);
    // Queda constancia del limite, que es lo que pide el ticket.
    expect(avisos[0]).toContain('exceeded the Rate Limit');

    const health = await handle.state.read([COINGECKO_SOURCE_ID]);
    expect(health.status).toBe('degraded');
  });
});
