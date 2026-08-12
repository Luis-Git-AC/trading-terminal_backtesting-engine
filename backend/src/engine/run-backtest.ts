import type { Candle } from '@tt/shared';
import { checkExits, closePosition, openPosition, updateExcursions } from './broker.js';
import { createIndicatorRegistry } from './indicators/registry.js';
import { computeMetrics } from './metrics.js';
import { addPnl, round10 } from './num.js';
import { mulberry32 } from './prng.js';
import {
  ENGINE_VERSION,
  PROGRESS_EVERY_BARS,
  type BacktestInput,
  type BacktestResult,
  type EquityPoint,
  type ExitReason,
  type Position,
  type Signal,
  type Trade,
} from './types.js';

export const SERIES_PROBLEMS = ['unordered', 'duplicate', 'invalid-timestamp'] as const;

export type SeriesProblem = (typeof SERIES_PROBLEMS)[number];

export class InvalidCandleSeriesError extends Error {
  override readonly name = 'InvalidCandleSeriesError';
  readonly problem: SeriesProblem;
  readonly index: number;

  constructor(problem: SeriesProblem, index: number) {
    super(`Serie de velas invalida en el indice ${index}: ${problem}.`);
    this.problem = problem;
    this.index = index;
  }
}

export function assertValidSeries(candles: readonly Candle[]): void {
  for (let i = 0; i < candles.length; i += 1) {
    const current = candles[i];
    if (current === undefined || !Number.isFinite(current.t)) {
      throw new InvalidCandleSeriesError('invalid-timestamp', i);
    }
    if (i === 0) {
      continue;
    }
    const previous = candles[i - 1];
    if (previous === undefined) {
      throw new InvalidCandleSeriesError('invalid-timestamp', i - 1);
    }
    if (current.t === previous.t) {
      throw new InvalidCandleSeriesError('duplicate', i);
    }
    if (current.t < previous.t) {
      throw new InvalidCandleSeriesError('unordered', i);
    }
  }
}

interface PendingSignal {
  readonly signal: Extract<Signal, { type: 'enter' | 'reverse' | 'exit' }>;
}

export function runBacktest<P, S>(input: BacktestInput<P, S>): BacktestResult {
  const { candles, strategy, exec, seed } = input;
  assertValidSeries(candles);

  const params = strategy.paramsSchema.parse(input.params);
  const warmupBars = strategy.warmupBars(params);
  const prng = mulberry32(seed);
  const indicators = createIndicatorRegistry();
  const state = strategy.init(params, { prng, indicators });

  const progressEvery = input.progressEveryBars ?? PROGRESS_EVERY_BARS;
  const barsTotal = candles.length;

  const trades: Trade[] = [];
  const equityCurve: EquityPoint[] = [];
  let equity = exec.initialCapital;
  let peak = equity;
  let position: Position | null = null;
  let pending: PendingSignal | null = null;
  let rejectedSignals = 0;
  let barsInPosition = 0;

  const pushEquity = (t: number): void => {
    if (equity > peak) {
      peak = equity;
    }
    const drawdown = peak > 0 ? round10((peak - equity) / peak) : 0;
    equityCurve.push({ t, equity: round10(equity), drawdown });
  };

  const closeAt = (exitPrice: number, exitTs: number, reason: ExitReason): void => {
    if (position === null) {
      return;
    }
    const trade = closePosition({
      position,
      exitPrice,
      exitTs,
      reason,
      exec,
      seq: trades.length + 1,
    });
    trades.push(trade);
    equity = addPnl(equity, trade.pnlQuote);
    position = null;
    pushEquity(exitTs);
  };

  const tryOpen = (
    signal: Extract<Signal, { type: 'enter' | 'reverse' }>,
    bar: Candle,
    index: number,
  ): void => {
    if (signal.side === 'short' && exec.allowShort === false) {
      rejectedSignals += 1;
      return;
    }
    const result = openPosition({
      side: signal.side,
      index,
      ts: bar.t,
      referencePrice: bar.o,
      stopPrice: signal.stopPrice,
      equity,
      exec,
      ...(signal.takeProfitR === undefined ? {} : { takeProfitR: signal.takeProfitR }),
    });
    if (!result.ok) {
      rejectedSignals += 1;
      return;
    }
    position = result.position;
  };

  if (barsTotal > 0) {
    const first = candles[0];
    if (first !== undefined) {
      pushEquity(first.t);
    }
  }

  for (let i = 0; i < barsTotal; i += 1) {
    const bar = candles[i];
    if (bar === undefined) {
      continue;
    }

    if (pending !== null) {
      const { signal } = pending;
      pending = null;
      if (signal.type === 'exit') {
        closeAt(bar.o, bar.t, 'signal');
      } else if (signal.type === 'reverse') {
        closeAt(bar.o, bar.t, 'signal');
        tryOpen(signal, bar, i);
      } else if (position === null) {
        tryOpen(signal, bar, i);
      }
    }

    indicators.updateAll(bar);

    if (position !== null) {
      barsInPosition += 1;
      updateExcursions(position, bar);
      const exit = checkExits(position, bar);
      if (exit !== null) {
        closeAt(exit.price, bar.t, exit.reason);
      }
    }

    if (i >= warmupBars) {
      const signal = strategy.onBar(bar, state, {
        index: i,
        position,
        indicators,
        prng,
      });
      if (signal !== null) {
        const actionable =
          signal.type === 'enter'
            ? position === null
            : position !== null;
        if (actionable) {
          pending = { signal };
        }
      }
    }

    if (progressEvery > 0 && (i + 1) % progressEvery === 0) {
      input.onProgress?.({
        barsDone: i + 1,
        barsTotal,
        trades: trades.length,
        equity: round10(equity),
      });
    }
  }

  const openAtEnd = position !== null;
  if (position !== null && barsTotal > 0) {
    const last = candles[barsTotal - 1];
    if (last !== undefined) {
      closeAt(last.c, last.t, 'end-of-data');
    }
  }

  return {
    engineVersion: ENGINE_VERSION,
    metrics: computeMetrics({
      trades,
      equityCurve,
      exec,
      barsTotal,
      barsInPosition,
      openAtEnd,
    }),
    trades,
    equityCurve,
    rejectedSignals,
  };
}
