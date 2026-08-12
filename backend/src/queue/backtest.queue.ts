import { BACKTEST_QUEUE_NAME, backtestJobSchema, type BacktestJob } from '@tt/shared';
import { Queue, type JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';

export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 2,
  backoff: { type: 'exponential', delay: 1_000 },
  removeOnComplete: { age: 86_400, count: 500 },
  removeOnFail: { age: 604_800 },
};

export interface BacktestQueue {
  readonly queue: Queue<BacktestJob>;
  enqueue(job: BacktestJob): Promise<string>;
  remove(runId: string): Promise<boolean>;
  countPending(): Promise<number>;
  close(): Promise<void>;
}

export function createBacktestQueue(connection: Redis): BacktestQueue {
  const queue = new Queue<BacktestJob>(BACKTEST_QUEUE_NAME, {
    connection,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });

  return {
    queue,
    async enqueue(job: BacktestJob): Promise<string> {
      const payload = backtestJobSchema.parse(job);
      const added = await queue.add(BACKTEST_QUEUE_NAME, payload, { jobId: payload.runId });
      return added.id ?? payload.runId;
    },
    async remove(runId: string): Promise<boolean> {
      const removed = await queue.remove(runId);
      return removed > 0;
    },
    async countPending(): Promise<number> {
      const counts = await queue.getJobCounts('waiting', 'active', 'delayed');
      return (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0);
    },
    async close(): Promise<void> {
      await queue.close();
    },
  };
}
