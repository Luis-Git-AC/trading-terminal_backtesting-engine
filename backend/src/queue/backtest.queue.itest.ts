import { randomUUID } from 'node:crypto';
import { BACKTEST_QUEUE_NAME, backtestJobSchema, runChannel } from '@tt/shared';
import type { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createBacktestQueue, DEFAULT_JOB_OPTIONS, type BacktestQueue } from './backtest.queue.js';
import { createQueueConnection } from './connection.js';

function requireRedisUrl(): string {
  const url = process.env.REDIS_URL;
  if (url === undefined || url === '') {
    throw new Error('REDIS_URL no esta definida. Copia .env.example a .env y ejecuta npm run db:up.');
  }
  return url;
}

describe('cola de backtests', () => {
  let connection: Redis;
  let backtests: BacktestQueue;

  beforeAll(async () => {
    connection = createQueueConnection(requireRedisUrl());
    backtests = createBacktestQueue(connection);
    await backtests.queue.obliterate({ force: true });
  });

  afterEach(async () => {
    await backtests.queue.obliterate({ force: true });
  });

  afterAll(async () => {
    await backtests.close();
    connection.disconnect();
  });

  it('encola un job cuyo id es el runId', async () => {
    const runId = randomUUID();
    const jobId = await backtests.enqueue({ runId });

    expect(jobId).toBe(runId);
    expect(await backtests.countPending()).toBe(1);
  });

  it('encolar dos veces el mismo runId deja un unico job', async () => {
    const runId = randomUUID();

    await backtests.enqueue({ runId });
    await backtests.enqueue({ runId });

    expect(await backtests.countPending()).toBe(1);
  });

  it('runIds distintos si producen jobs distintos', async () => {
    await backtests.enqueue({ runId: randomUUID() });
    await backtests.enqueue({ runId: randomUUID() });

    expect(await backtests.countPending()).toBe(2);
  });

  it('el payload que viaja es solo { runId } y valida contra su esquema', async () => {
    const runId = randomUUID();
    await backtests.enqueue({ runId });

    const job = await backtests.queue.getJob(runId);
    expect(job).toBeDefined();
    expect(job?.data).toEqual({ runId });
    expect(Object.keys(job?.data ?? {})).toEqual(['runId']);
    expect(() => backtestJobSchema.parse(job?.data)).not.toThrow();
  });

  it('rechaza un runId que no es un uuid antes de tocar Redis', async () => {
    await expect(backtests.enqueue({ runId: 'no-soy-un-uuid' })).rejects.toThrow();
    expect(await backtests.countPending()).toBe(0);
  });

  it('aplica los defaultJobOptions documentados', async () => {
    const runId = randomUUID();
    await backtests.enqueue({ runId });

    const job = await backtests.queue.getJob(runId);
    expect(job?.opts.attempts).toBe(2);
    expect(job?.opts.backoff).toEqual({ type: 'exponential', delay: 1_000 });
    expect(DEFAULT_JOB_OPTIONS.removeOnComplete).toEqual({ age: 86_400, count: 500 });
    expect(DEFAULT_JOB_OPTIONS.removeOnFail).toEqual({ age: 604_800 });
  });

  it('usa el nombre de cola del contrato compartido', () => {
    expect(backtests.queue.name).toBe(BACKTEST_QUEUE_NAME);
    expect(BACKTEST_QUEUE_NAME).toBe('backtest');
  });

  it('close() marca la cola como cerrada y resuelve sin colgarse', async () => {
    const local = createQueueConnection(requireRedisUrl());
    const queue = createBacktestQueue(local);
    await queue.enqueue({ runId: randomUUID() });

    expect(queue.queue.closing).toBeUndefined();
    await queue.close();
    expect(queue.queue.closing).toBeDefined();

    await backtests.queue.obliterate({ force: true });
  });

  it('el canal de progreso sigue el formato de docs/01', () => {
    const runId = randomUUID();
    expect(runChannel(runId)).toBe(`ch:run:${runId}`);
  });
});
