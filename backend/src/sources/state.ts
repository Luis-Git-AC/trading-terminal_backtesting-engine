import { sourceStateKey, type SourceHealth, type SourcesHealth } from '@tt/shared';

/** El collector y el API son procesos distintos: el estado por fuente viaja por Redis. */
export interface SourceStateStore {
  recordOk(sourceId: string, at: number, items: number): Promise<void>;
  recordError(sourceId: string, at: number, message: string): Promise<void>;
  read(sourceIds: readonly string[]): Promise<SourcesHealth>;
}

export interface RedisLike {
  hset(key: string, values: Record<string, string>): Promise<unknown>;
  hgetall(key: string): Promise<Record<string, string>>;
}

function intOrNull(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : null;
}

/** Un error posterior al ultimo ok degrada la fuente; sin ninguna ejecucion queda en `pending`. */
export function toSourceHealth(id: string, raw: Record<string, string>): SourceHealth {
  const lastOkAt = intOrNull(raw.lastOkAt);
  const lastErrorAt = intOrNull(raw.lastErrorAt);
  const lastError = raw.lastError ?? null;
  const items = intOrNull(raw.items);

  let state: SourceHealth['state'] = 'pending';
  if (lastErrorAt !== null && (lastOkAt === null || lastErrorAt > lastOkAt)) state = 'error';
  else if (lastOkAt !== null) state = 'ok';

  return { id, state, lastOkAt, lastErrorAt, lastError, items };
}

export function createSourceStateStore(redis: RedisLike): SourceStateStore {
  return {
    async recordOk(sourceId: string, at: number, items: number): Promise<void> {
      await redis.hset(sourceStateKey(sourceId), {
        lastOkAt: String(at),
        items: String(items),
      });
    },

    async recordError(sourceId: string, at: number, message: string): Promise<void> {
      await redis.hset(sourceStateKey(sourceId), {
        lastErrorAt: String(at),
        lastError: message.slice(0, 500),
      });
    },

    async read(sourceIds: readonly string[]): Promise<SourcesHealth> {
      const sources = await Promise.all(
        sourceIds.map(async (id) => toSourceHealth(id, await redis.hgetall(sourceStateKey(id)))),
      );

      return {
        status: sources.some((source) => source.state === 'error') ? 'degraded' : 'ok',
        sources,
      };
    },
  };
}
