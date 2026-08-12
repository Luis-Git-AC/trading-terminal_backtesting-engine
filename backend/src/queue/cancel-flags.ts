import { RUN_CANCEL_TTL_SEC, runCancelKey } from '@tt/shared';

export interface CancelFlagStore {
  request(runId: string): Promise<void>;
  isRequested(runId: string): Promise<boolean>;
}

export interface CancelFlagRedis {
  set(key: string, value: string, mode: 'EX', ttlSec: number): Promise<unknown>;
  exists(key: string): Promise<number>;
}

export function createRedisCancelFlags(
  redis: CancelFlagRedis,
  ttlSec: number = RUN_CANCEL_TTL_SEC,
): CancelFlagStore {
  return {
    async request(runId: string): Promise<void> {
      await redis.set(runCancelKey(runId), '1', 'EX', ttlSec);
    },
    async isRequested(runId: string): Promise<boolean> {
      return (await redis.exists(runCancelKey(runId))) > 0;
    },
  };
}
