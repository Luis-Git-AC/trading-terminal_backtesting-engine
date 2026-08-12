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
