import { addPnl, round10 } from './num.js';
import type { BacktestMetrics, EquityPoint, ExecConfig, Trade } from './types.js';

export interface MetricsInput {
  readonly trades: readonly Trade[];
  readonly equityCurve: readonly EquityPoint[];
  readonly exec: ExecConfig;
  readonly barsTotal: number;
  readonly barsInPosition: number;
  readonly openAtEnd: boolean;
}

export interface DrawdownSummary {
  readonly fraction: number;
  readonly quote: number;
}

export const EQUITY_MAX_POINTS = 5000;

export interface DrawdownExtremes {
  readonly peakIndex: number;
  readonly troughIndex: number;
}

export function drawdownExtremes(curve: readonly EquityPoint[]): DrawdownExtremes {
  let peak = Number.NEGATIVE_INFINITY;
  let peakIndex = 0;
  let worstFraction = 0;
  let bestPeakIndex = 0;
  let troughIndex = 0;

  curve.forEach((point, index) => {
    if (point.equity > peak) {
      peak = point.equity;
      peakIndex = index;
    }
    if (peak <= 0) {
      return;
    }
    const fraction = (peak - point.equity) / peak;
    if (fraction > worstFraction) {
      worstFraction = fraction;
      bestPeakIndex = peakIndex;
      troughIndex = index;
    }
  });

  return { peakIndex: bestPeakIndex, troughIndex };
}

export function downsampleEquity(
  curve: readonly EquityPoint[],
  maxPoints: number = EQUITY_MAX_POINTS,
): EquityPoint[] {
  const total = curve.length;
  if (total === 0) {
    return [];
  }
  if (total <= maxPoints || maxPoints < 2) {
    return [...curve];
  }

  const extremes = drawdownExtremes(curve);
  const keep = new Set<number>([0, total - 1, extremes.peakIndex, extremes.troughIndex]);
  const buckets = Math.max(0, Math.floor((maxPoints - keep.size) / 2));

  for (let bucket = 0; bucket < buckets; bucket += 1) {
    const start = Math.floor((bucket * total) / buckets);
    const end = Math.floor(((bucket + 1) * total) / buckets);
    if (end <= start) {
      continue;
    }
    let lowest = start;
    let highest = start;
    for (let i = start; i < end; i += 1) {
      const equity = curve[i]?.equity ?? 0;
      if (equity < (curve[lowest]?.equity ?? 0)) {
        lowest = i;
      }
      if (equity > (curve[highest]?.equity ?? 0)) {
        highest = i;
      }
    }
    keep.add(lowest);
    keep.add(highest);
  }

  return [...keep]
    .sort((a, b) => a - b)
    .map((index) => curve[index])
    .filter((point): point is EquityPoint => point !== undefined);
}

export function maxDrawdown(curve: readonly EquityPoint[]): DrawdownSummary {
  let peak = Number.NEGATIVE_INFINITY;
  let worstFraction = 0;
  let worstQuote = 0;

  for (const point of curve) {
    if (point.equity > peak) {
      peak = point.equity;
    }
    if (peak <= 0) {
      continue;
    }
    const drop = peak - point.equity;
    const fraction = drop / peak;
    if (fraction > worstFraction) {
      worstFraction = fraction;
      worstQuote = drop;
    }
  }

  return { fraction: round10(worstFraction), quote: round10(worstQuote) };
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  let total = 0;
  for (const value of values) {
    total = addPnl(total, value);
  }
  return round10(total / values.length);
}

export function computeMetrics(input: MetricsInput): BacktestMetrics {
  const { trades, exec, barsTotal, barsInPosition } = input;

  let netProfit = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  const winnersR: number[] = [];
  const losersR: number[] = [];
  const allR: number[] = [];

  for (const trade of trades) {
    netProfit = addPnl(netProfit, trade.pnlQuote);
    allR.push(trade.pnlR);
    if (trade.pnlQuote > 0) {
      grossProfit = addPnl(grossProfit, trade.pnlQuote);
      winnersR.push(trade.pnlR);
    } else {
      grossLoss = addPnl(grossLoss, trade.pnlQuote);
      losersR.push(trade.pnlR);
    }
  }

  const drawdown = maxDrawdown(input.equityCurve);
  const tradeCount = trades.length;

  return {
    netProfit: round10(netProfit),
    netProfitPct:
      exec.initialCapital === 0 ? 0 : round10((netProfit / exec.initialCapital) * 100),
    maxDrawdown: drawdown.fraction,
    maxDrawdownQuote: drawdown.quote,
    winRate: tradeCount === 0 ? null : round10(winnersR.length / tradeCount),
    profitFactor: grossLoss === 0 ? null : round10(grossProfit / Math.abs(grossLoss)),
    expectancyR: mean(allR),
    trades: tradeCount,
    wins: winnersR.length,
    losses: losersR.length,
    avgWinR: mean(winnersR),
    avgLossR: mean(losersR),
    largestWinR: winnersR.length === 0 ? null : round10(Math.max(...winnersR)),
    largestLossR: losersR.length === 0 ? null : round10(Math.min(...losersR)),
    exposurePct: barsTotal === 0 ? 0 : round10((barsInPosition / barsTotal) * 100),
    barsTotal,
    openAtEnd: input.openAtEnd,
  };
}
