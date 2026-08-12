import type { Candle } from '@tt/shared';
import type { ZodType } from 'zod';

export const ENGINE_VERSION = '1.0.0' as const;

export const FILL_MODELS = ['next-open'] as const;

export type FillModel = (typeof FILL_MODELS)[number];

export const SIDES = ['long', 'short'] as const;

export type Side = (typeof SIDES)[number];

export const EXIT_REASONS = ['stop', 'take-profit', 'signal', 'end-of-data'] as const;

export type ExitReason = (typeof EXIT_REASONS)[number];

export interface ExecConfig {
  readonly initialCapital: number;
  readonly riskPerTradePct: number;
  readonly feeBps: number;
  readonly slippageBps: number;
  readonly fillModel: FillModel;
  readonly allowShort?: boolean;
  readonly markToMarket?: boolean;
}

export type Signal =
  | {
      readonly type: 'enter';
      readonly side: Side;
      readonly stopPrice: number;
      readonly takeProfitR?: number;
    }
  | { readonly type: 'exit'; readonly reason: string }
  | {
      readonly type: 'reverse';
      readonly side: Side;
      readonly stopPrice: number;
      readonly takeProfitR?: number;
    };

export interface Position {
  readonly side: Side;
  readonly entryIndex: number;
  readonly entryTs: number;
  readonly entryPrice: number;
  readonly qty: number;
  readonly stopPrice: number;
  readonly takeProfitPrice: number | null;
  readonly riskQuote: number;
  readonly entryFee: number;
  maeQuote: number;
  mfeQuote: number;
}

export interface Trade {
  readonly seq: number;
  readonly side: Side;
  readonly entryTs: number;
  readonly entryPrice: number;
  readonly exitTs: number;
  readonly exitPrice: number;
  readonly qty: number;
  readonly fees: number;
  readonly pnlQuote: number;
  readonly pnlR: number;
  readonly exitReason: ExitReason;
  readonly maeR: number;
  readonly mfeR: number;
}

export interface EquityPoint {
  readonly t: number;
  readonly equity: number;
  readonly drawdown: number;
}

export interface BacktestMetrics {
  readonly netProfit: number;
  readonly netProfitPct: number;
  readonly maxDrawdown: number;
  readonly maxDrawdownQuote: number;
  readonly winRate: number | null;
  readonly profitFactor: number | null;
  readonly expectancyR: number | null;
  readonly trades: number;
  readonly wins: number;
  readonly losses: number;
  readonly avgWinR: number | null;
  readonly avgLossR: number | null;
  readonly largestWinR: number | null;
  readonly largestLossR: number | null;
  readonly exposurePct: number;
  readonly barsTotal: number;
  readonly openAtEnd: boolean;
}

export interface BacktestResult {
  readonly engineVersion: string;
  readonly metrics: BacktestMetrics;
  readonly trades: readonly Trade[];
  readonly equityCurve: readonly EquityPoint[];
  readonly rejectedSignals: number;
}

export interface Indicator<TInput = number> {
  update(input: TInput): number | null;
  get(): number | null;
  readonly ready: boolean;
}

export interface IndicatorRegistry {
  get(key: string): number | null;
  ready(key: string): boolean;
}

export interface IndicatorRegistrar {
  register<TInput>(
    key: string,
    indicator: Indicator<TInput>,
    select: (bar: Candle) => TInput,
  ): void;
}

export interface InitContext {
  readonly prng: () => number;
  readonly indicators: IndicatorRegistrar;
}

export interface BarContext {
  readonly index: number;
  readonly position: Position | null;
  readonly indicators: IndicatorRegistry;
  readonly prng: () => number;
}

export interface StrategyDefinition<P = Record<string, unknown>, S = unknown> {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly paramsSchema: ZodType<P>;
  warmupBars(params: P): number;
  init(params: P, ctx: InitContext): S;
  onBar(bar: Candle, state: S, ctx: BarContext): Signal | null;
}

export interface ProgressEvent {
  readonly barsDone: number;
  readonly barsTotal: number;
  readonly trades: number;
  readonly equity: number;
}

export interface BacktestInput<P = Record<string, unknown>, S = unknown> {
  readonly candles: readonly Candle[];
  readonly strategy: StrategyDefinition<P, S>;
  readonly params: Record<string, number | boolean>;
  readonly exec: ExecConfig;
  readonly seed: number;
  readonly onProgress?: (progress: ProgressEvent) => void;
  readonly progressEveryBars?: number;
}

export const PROGRESS_EVERY_BARS = 1000;
