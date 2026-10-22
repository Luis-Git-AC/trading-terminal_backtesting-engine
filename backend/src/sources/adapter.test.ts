import { describe, expect, it } from 'vitest';
import { createRateLimiter } from '../ingest/rate-limiter.js';
import {
  toRunnable,
  type NormalizedBatch,
  type SourceAdapter,
  type SourceContext,
  type SourceItem,
} from './adapter.js';

interface Item extends SourceItem {
  readonly value: number;
}

const CONTEXT: SourceContext = { limiter: createRateLimiter({ rps: 1000 }), now: () => 1_000 };

function source(
  overrides: Partial<SourceAdapter<readonly number[], Item>> = {},
  log: string[] = [],
): SourceAdapter<readonly number[], Item> {
  return {
    id: 'prueba',
    schedule: '*/5 * * * *',
    fetch: () => {
      log.push('fetch');
      return Promise.resolve([1, 2, 3]);
    },
    normalize: (raw) => {
      log.push('normalize');
      return {
        sourceId: 'prueba',
        items: raw.map((value) => ({ value, publishedAt: value, fetchedAt: 1_000 })),
        discarded: 1,
      };
    },
    persist: (batch: NormalizedBatch<Item>) => {
      log.push('persist');
      return Promise.resolve({ written: batch.items.length, skipped: 0 });
    },
    ...overrides,
  };
}

describe('toRunnable', () => {
  it('compone las tres fases en orden y resume el resultado', async () => {
    const log: string[] = [];
    const report = await toRunnable(source({}, log)).run(null, CONTEXT);

    expect(log).toEqual(['fetch', 'normalize', 'persist']);
    expect(report).toEqual({
      sourceId: 'prueba',
      items: 3,
      discarded: 1,
      written: 3,
      skipped: 0,
      durationMs: 0,
    });
  });

  it('expone id, schedule y requiredEnv, con requiredEnv vacio por defecto', () => {
    expect(toRunnable(source())).toMatchObject({
      id: 'prueba',
      schedule: '*/5 * * * *',
      requiredEnv: [],
    });
    expect(toRunnable(source({ requiredEnv: ['UNA_CLAVE'] })).requiredEnv).toEqual(['UNA_CLAVE']);
  });

  it('pasa `since` tal cual a la fuente', async () => {
    const seen: (Date | null)[] = [];
    const since = new Date('2026-10-22T00:00:00Z');
    await toRunnable(
      source({
        fetch: (value) => {
          seen.push(value);
          return Promise.resolve([]);
        },
      }),
    ).run(since, CONTEXT);

    expect(seen).toEqual([since]);
  });

  it('un fallo en cualquiera de las tres fases sube al llamante y corta las siguientes', async () => {
    for (const phase of ['fetch', 'normalize', 'persist'] as const) {
      const log: string[] = [];
      const boom = (): never => {
        throw new Error(`revento en ${phase}`);
      };

      await expect(
        toRunnable(source({ [phase]: boom }, log)).run(null, CONTEXT),
      ).rejects.toThrow(`revento en ${phase}`);

      expect(log).not.toContain(phase);
    }
  });
});
