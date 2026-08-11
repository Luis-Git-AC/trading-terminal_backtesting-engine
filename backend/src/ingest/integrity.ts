import {
  expectedCandleCount,
  isAligned,
  timeframeToMs,
  type Candle,
  type Timeframe,
} from '@tt/shared';
import {
  MAX_CANDLES_LIMIT,
  createCandlesRepository,
  type Gap,
  type Queryable,
} from '../db/repositories/candles.repo.js';

const DEFAULT_MAX_VIOLATIONS = 50;

export const VIOLATION_KINDS = [
  'unaligned',
  'duplicate',
  'out-of-order',
  'invalid-ohlc',
  'negative-volume',
  'future',
  'unclosed',
] as const;

export type ViolationKind = (typeof VIOLATION_KINDS)[number];

export interface IntegrityViolation {
  kind: ViolationKind;
  ts: number;
  detail: string;
}

export interface IntegrityReport {
  exchange: string | undefined;
  symbol: string;
  timeframe: Timeframe;
  from: number;
  to: number;
  expected: number;
  actual: number;
  firstTs: number | null;
  lastTs: number | null;
  violations: IntegrityViolation[];
  violationCounts: Record<ViolationKind, number>;
  totalViolations: number;
  gaps: Gap[];
  missing: number;
  ok: boolean;
}

export interface VerifyIntegrityOptions {
  db: Queryable;
  exchange?: string | undefined;
  symbol: string;
  timeframe: Timeframe;
  from: number;
  to: number;
  now?: () => number;
  pageSize?: number;
  maxViolations?: number;
}

function emptyCounts(): Record<ViolationKind, number> {
  return {
    unaligned: 0,
    duplicate: 0,
    'out-of-order': 0,
    'invalid-ohlc': 0,
    'negative-volume': 0,
    future: 0,
    unclosed: 0,
  };
}

export async function verifyIntegrity(options: VerifyIntegrityOptions): Promise<IntegrityReport> {
  const {
    db,
    exchange,
    symbol,
    timeframe,
    from,
    to,
    now = Date.now,
    pageSize = MAX_CANDLES_LIMIT,
    maxViolations = DEFAULT_MAX_VIOLATIONS,
  } = options;

  const series = { exchange, symbol, timeframe };
  const candles = createCandlesRepository(db);

  const violations: IntegrityViolation[] = [];
  const violationCounts = emptyCounts();
  let totalViolations = 0;

  const record = (kind: ViolationKind, ts: number, detail: string): void => {
    violationCounts[kind] += 1;
    totalViolations += 1;
    if (violations.length < maxViolations) violations.push({ kind, ts, detail });
  };

  const nowMs = now();
  const step = timeframeToMs(timeframe);
  let cursor = from;
  let previous: Candle | null = null;
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  let actual = 0;

  for (;;) {
    const page = await candles.getCandles({ ...series, from: cursor, to, limit: pageSize });
    if (page.length === 0) break;

    for (const candle of page) {
      actual += 1;
      firstTs ??= candle.t;
      lastTs = candle.t;

      if (!isAligned(candle.t, timeframe)) {
        record('unaligned', candle.t, `no cae en un limite de vela de ${timeframe}`);
      }

      if (previous !== null && candle.t < previous.t) {
        record('out-of-order', candle.t, `llega despues de ${previous.t}`);
      }

      if (
        candle.h < candle.l ||
        candle.h < Math.max(candle.o, candle.c) ||
        candle.l > Math.min(candle.o, candle.c)
      ) {
        record(
          'invalid-ohlc',
          candle.t,
          `OHLC incoherente: o=${candle.o} h=${candle.h} l=${candle.l} c=${candle.c}`,
        );
      }

      if (candle.v < 0) {
        record('negative-volume', candle.t, `volumen negativo: ${candle.v}`);
      }

      if (candle.t > nowMs) {
        record('future', candle.t, `esta en el futuro (ahora: ${nowMs})`);
      } else if (candle.t + step > nowMs) {
        record(
          'unclosed',
          candle.t,
          `sigue en formacion: cierra en ${candle.t + step} y ahora es ${nowMs}`,
        );
      }

      previous = candle;
    }

    if (page.length < pageSize) break;
    const last = page[page.length - 1];
    if (last === undefined) break;
    cursor = last.t + 1;
  }

  for (const duplicate of await candles.findDuplicates({ ...series, from, to })) {
    record('duplicate', duplicate.ts, `${duplicate.count} filas con el mismo ts`);
  }

  const gaps = await candles.findGaps({ ...series, from, to });
  const expected = expectedCandleCount(from, to, timeframe);

  return {
    ...series,
    from,
    to,
    expected,
    actual,
    firstTs,
    lastTs,
    violations,
    violationCounts,
    totalViolations,
    gaps,
    missing: Math.max(0, expected - actual),
    ok: totalViolations === 0,
  };
}
