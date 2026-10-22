import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import { createLogger } from '../observability/logger.js';
import { createQueueConnection } from '../queue/connection.js';
import { createScratchDatabase, type ScratchDatabase } from '../testing/scratch-db.js';
import type { RunnableSource, SourceRunReport } from '../sources/adapter.js';
import { buildSourceRegistry } from '../sources/registry.js';
import { startCollector, type CollectorHandle } from './collector.js';

const SCHEDULE = '*/5 * * * *';

/** Un prefijo por caso: los schedulers viven en Redis y sobreviven al `stop()`, a proposito. */
function freshPrefix(): string {
  return `tt-itest-collector-${randomUUID().slice(0, 8)}`;
}

function requireRedisUrl(): string {
  const url = process.env.REDIS_URL;
  if (url === undefined || url === '') {
    throw new Error('REDIS_URL no esta definida. Copia .env.example a .env y ejecuta npm run db:up.');
  }
  return url;
}

interface FakeSource extends RunnableSource {
  readonly calls: (Date | null)[];
}

function fakeSource(
  id: string,
  behaviour: { readonly fails?: boolean; readonly items?: number; readonly requiredEnv?: readonly string[] } = {},
): FakeSource {
  const calls: (Date | null)[] = [];

  return {
    id,
    schedule: SCHEDULE,
    requiredEnv: behaviour.requiredEnv ?? [],
    calls,
    run(since): Promise<SourceRunReport> {
      calls.push(since);
      if (behaviour.fails === true) {
        return Promise.reject(new Error(`la fuente ${id} revento`));
      }
      const items = behaviour.items ?? 1;
      return Promise.resolve({
        sourceId: id,
        items,
        discarded: 0,
        written: items,
        skipped: 0,
        durationMs: 1,
      });
    },
  };
}

describe('rol collector', () => {
  const redisUrl = requireRedisUrl();
  let db: ScratchDatabase;
  let redis: Redis;
  let handle: CollectorHandle | undefined;
  let prefix: string;

  beforeAll(async () => {
    db = await createScratchDatabase({ applicationName: 'tt-itest-collector' });
    await runMigrations({ pool: db.pool });
    redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  });

  afterAll(async () => {
    // Los schedulers y el estado de los casos viven en el Redis de desarrollo y no caducan: sin
    // esto cada ejecucion de la suite deja cientos de claves `tt-itest-collector-*` para siempre.
    const leftovers = await redis.keys('tt-itest-collector-*');
    if (leftovers.length > 0) await redis.del(...leftovers);
    await redis.quit();
    await db.drop();
  });

  /**
   * `keyPrefix` aisla el estado del caso. Sin el habria que limpiar `source:state:*` a mano, y eso
   * arrasaba las claves del collector de verdad que corre contra el mismo Redis de desarrollo.
   */
  function stateClient(): Redis {
    return new Redis(redisUrl, { maxRetriesPerRequest: null, keyPrefix: `${prefix}:` });
  }

  beforeEach(() => {
    handle = undefined;
    prefix = freshPrefix();
  });

  afterEach(async () => {
    await handle?.stop();
  });

  async function launch(
    candidates: readonly RunnableSource[],
    options: { readonly env?: Record<string, string | undefined>; readonly runOnStart?: boolean } = {},
  ): Promise<CollectorHandle> {
    const created = await startCollector({
      pool: db.pool,
      connection: createQueueConnection(redisUrl),
      redis: stateClient(),
      logger: createLogger({ role: 'collector', level: 'silent' }),
      registry: buildSourceRegistry({ candidates, env: options.env ?? {} }),
      prefix,
      closePool: false,
      signals: [],
      ...(options.runOnStart === undefined ? {} : { runOnStart: options.runOnStart }),
    });
    handle = created;
    return created;
  }

  it('arranca, registra un job repeatable por fuente y apaga limpiamente', async () => {
    const created = await launch([fakeSource('uno'), fakeSource('dos')]);

    const schedulers = await created.queue.getJobSchedulers();
    expect(schedulers.map((item) => item.key).sort()).toEqual(['dos', 'uno']);
    expect(schedulers.every((item) => item.pattern === SCHEDULE)).toBe(true);

    await created.stop();
    expect(created.worker.isRunning()).toBe(false);

    // Apagar dos veces no revienta: el segundo stop reutiliza la misma promesa.
    await expect(created.stop()).resolves.toBeUndefined();
    handle = undefined;
  });

  it('apaga con SIGTERM y sale con codigo 0', async () => {
    const exit = vi.fn();
    const created = await startCollector({
      pool: db.pool,
      connection: createQueueConnection(redisUrl),
      redis: stateClient(),
      logger: createLogger({ role: 'collector', level: 'silent' }),
      registry: buildSourceRegistry({ candidates: [fakeSource('uno')], env: {} }),
      prefix,
      closePool: false,
      signals: ['SIGTERM'],
      exit,
    });
    handle = created;

    process.emit('SIGTERM');
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(0);
    });
    expect(created.worker.isRunning()).toBe(false);
    handle = undefined;
  });

  it('una fuente que lanza excepcion no impide que las demas corran', async () => {
    const roto = fakeSource('roto', { fails: true });
    const sano = fakeSource('sano', { items: 3 });
    const created = await launch([roto, sano], { runOnStart: true });

    expect(roto.calls).toHaveLength(1);
    expect(sano.calls).toHaveLength(1);

    const health = await created.state.read(['roto', 'sano']);
    expect(health.status).toBe('degraded');
    expect(health.sources.find((source) => source.id === 'roto')).toMatchObject({
      state: 'error',
      lastError: 'la fuente roto revento',
    });
    expect(health.sources.find((source) => source.id === 'sano')).toMatchObject({
      state: 'ok',
      items: 3,
    });
  });

  it('sin la clave de una fuente, arranca, avisa y la omite', async () => {
    const conClave = fakeSource('fred', { requiredEnv: ['FRED_API_KEY'] });
    const sinClave = fakeSource('eia', { requiredEnv: ['EIA_API_KEY'] });

    const created = await launch([conClave, sinClave], {
      env: { FRED_API_KEY: 'presente', EIA_API_KEY: '' },
    });

    const schedulers = await created.queue.getJobSchedulers();
    expect(schedulers.map((item) => item.key)).toEqual(['fred']);

    await expect(created.runSourceNow('eia')).rejects.toThrow(/Fuente no activa: eia/);
    await expect(created.runSourceNow('fred')).resolves.toMatchObject({ sourceId: 'fred' });
  });

  it('el job de la cola ejecuta la fuente y deja su estado en Redis', async () => {
    const fuente = fakeSource('porcola', { items: 7 });
    const created = await launch([fuente]);

    await created.queue.add('collector', { sourceId: 'porcola' });

    await vi.waitFor(
      async () => {
        const health = await created.state.read(['porcola']);
        expect(health.sources[0]).toMatchObject({ state: 'ok', items: 7 });
      },
      { timeout: 10_000 },
    );
    expect(fuente.calls).toHaveLength(1);
  });

  it('un job de una fuente que no esta activa no se reintenta en bucle', async () => {
    const created = await launch([fakeSource('viva')]);

    const job = await created.queue.add('collector', { sourceId: 'fantasma' });

    await vi.waitFor(
      async () => {
        const state = await job.getState();
        expect(state).toBe('completed');
      },
      { timeout: 10_000 },
    );
  });

  it('un fallo repetido agota los intentos y el job queda en la cola de fallidos', async () => {
    const created = await launch([fakeSource('siemprefalla', { fails: true })]);

    const job = await created.queue.add(
      'collector',
      { sourceId: 'siemprefalla' },
      { attempts: 1 },
    );

    await vi.waitFor(
      async () => {
        expect(await job.getState()).toBe('failed');
      },
      { timeout: 10_000 },
    );

    const failed = await created.queue.getFailed();
    expect(failed.map((item) => item.data.sourceId)).toContain('siemprefalla');

    const health = await created.state.read(['siemprefalla']);
    expect(health.status).toBe('degraded');
  });

  it('retira el scheduler de una fuente que ha dejado de estar activa', async () => {
    const shared = freshPrefix();
    const common = {
      pool: db.pool,
      logger: createLogger({ role: 'collector' as const, level: 'silent' as const }),
      prefix: shared,
      closePool: false,
      signals: [] as readonly NodeJS.Signals[],
    };

    const first = await startCollector({
      ...common,
      connection: createQueueConnection(redisUrl),
      redis: stateClient(),
      registry: buildSourceRegistry({ candidates: [fakeSource('temporal')], env: {} }),
    });
    expect((await first.queue.getJobSchedulers()).map((item) => item.key)).toEqual(['temporal']);
    await first.stop();

    // Segundo arranque sin esa fuente: su clave ya no esta en el entorno.
    const second = await startCollector({
      ...common,
      connection: createQueueConnection(redisUrl),
      redis: stateClient(),
      registry: buildSourceRegistry({
        candidates: [fakeSource('temporal', { requiredEnv: ['FALTA'] })],
        env: {},
      }),
    });
    handle = second;

    expect(await second.queue.getJobSchedulers()).toEqual([]);
  });

  it('sin ninguna ejecucion la fuente queda pendiente, no en error', async () => {
    const created = await launch([fakeSource('nuncacorre')]);

    const health = await created.state.read(['nuncacorre']);
    expect(health).toEqual({
      status: 'ok',
      sources: [
        {
          id: 'nuncacorre',
          state: 'pending',
          lastOkAt: null,
          lastErrorAt: null,
          lastError: null,
          items: null,
        },
      ],
    });
  });
});
