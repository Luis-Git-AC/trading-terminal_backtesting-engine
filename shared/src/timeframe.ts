import { z } from 'zod';

export const TIMEFRAMES = ['1m', '15m', '1h'] as const;

export type Timeframe = (typeof TIMEFRAMES)[number];

export const timeframeSchema = z.enum(TIMEFRAMES);

const TIMEFRAME_MS = {
  '1m': 60_000,
  '15m': 900_000,
  '1h': 3_600_000,
} as const satisfies Record<Timeframe, number>;

export class InvalidTimestampError extends Error {
  override readonly name = 'InvalidTimestampError';
  readonly value: number;

  constructor(value: number) {
    super(`Timestamp invalido: ${value}. Se espera un epoch en ms entero y no negativo.`);
    this.value = value;
  }
}

function assertEpochMs(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InvalidTimestampError(value);
  }
}

export function isTimeframe(value: unknown): value is Timeframe {
  return typeof value === 'string' && TIMEFRAMES.some((timeframe) => timeframe === value);
}

export function timeframeToMs(timeframe: Timeframe): number {
  return TIMEFRAME_MS[timeframe];
}

export function alignTs(ts: number, timeframe: Timeframe): number {
  assertEpochMs(ts);
  return ts - (ts % timeframeToMs(timeframe));
}

export function isAligned(ts: number, timeframe: Timeframe): boolean {
  assertEpochMs(ts);
  return ts % timeframeToMs(timeframe) === 0;
}

export function expectedCandleCount(from: number, to: number, timeframe: Timeframe): number {
  assertEpochMs(from);
  assertEpochMs(to);
  const ms = timeframeToMs(timeframe);
  return Math.max(0, Math.ceil(to / ms) - Math.ceil(from / ms));
}
