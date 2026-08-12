import type { Candle } from '@tt/shared';
import { z } from 'zod';
import { createAtr } from '../engine/indicators/atr.js';
import { fromBar, fromClose } from '../engine/indicators/registry.js';
import { createRollingMax, createRollingMin } from '../engine/indicators/rolling.js';
import type { BarContext, InitContext, Signal, StrategyDefinition } from '../engine/types.js';

export const RANGE_HIGH = 'rangeHigh';
export const RANGE_LOW = 'rangeLow';
export const ATR = 'atr';

export const STOP_MODES = ['range', 'atr', 'nearest'] as const;

export type StopMode = (typeof STOP_MODES)[number];

export const rangeBreakoutParamsSchema = z.object({
  lookback: z.number().int().min(2).max(500).default(20),
  atrPeriod: z.number().int().min(2).max(100).default(14),
  atrStopMult: z.number().min(0.1).max(10).default(2),
  takeProfitR: z.number().min(0.1).max(20).default(2),
  minAtrPct: z.number().min(0).max(100).default(0),
  allowShort: z.boolean().default(true),
  stopMode: z.enum(STOP_MODES).default('nearest'),
});

export type RangeBreakoutParams = z.infer<typeof rangeBreakoutParamsSchema>;

export interface RangeBreakoutState {
  readonly params: RangeBreakoutParams;
  previousHigh: number | null;
  previousLow: number | null;
}

export function resolveStopPrice(
  side: 'long' | 'short',
  close: number,
  rangeLevel: number | null,
  atr: number,
  params: RangeBreakoutParams,
): number | null {
  const atrStop = side === 'long' ? close - params.atrStopMult * atr : close + params.atrStopMult * atr;

  if (params.stopMode === 'atr') {
    return atrStop;
  }
  if (rangeLevel === null) {
    return params.stopMode === 'range' ? null : atrStop;
  }
  if (params.stopMode === 'range') {
    return rangeLevel;
  }
  return side === 'long' ? Math.max(rangeLevel, atrStop) : Math.min(rangeLevel, atrStop);
}

export const rangeBreakout: StrategyDefinition<RangeBreakoutParams, RangeBreakoutState> = {
  id: 'range-breakout',
  name: 'Range Breakout',
  version: '1.0.0',
  description: 'Ruptura del maximo o minimo de las N barras previas, con filtro de volatilidad',
  paramsSchema: rangeBreakoutParamsSchema,

  warmupBars: (params: RangeBreakoutParams): number =>
    Math.max(params.lookback, params.atrPeriod) + 1,

  init: (params: RangeBreakoutParams, ctx: InitContext): RangeBreakoutState => {
    ctx.indicators.register(RANGE_HIGH, createRollingMax(params.lookback), fromClose);
    ctx.indicators.register(RANGE_LOW, createRollingMin(params.lookback), fromClose);
    ctx.indicators.register(ATR, createAtr(params.atrPeriod), fromBar);
    return { params, previousHigh: null, previousLow: null };
  },

  onBar: (bar: Candle, state: RangeBreakoutState, ctx: BarContext): Signal | null => {
    const { params } = state;
    const high = state.previousHigh;
    const low = state.previousLow;
    const atr = ctx.indicators.get(ATR);

    state.previousHigh = ctx.indicators.get(RANGE_HIGH);
    state.previousLow = ctx.indicators.get(RANGE_LOW);

    if (atr === null || high === null || low === null) {
      return null;
    }
    if (bar.c <= 0 || (atr / bar.c) * 100 <= params.minAtrPct) {
      return null;
    }

    const breakingUp = bar.c > high;
    const breakingDown = bar.c < low;

    if (!breakingUp && !breakingDown) {
      return null;
    }

    const side = breakingUp ? 'long' : 'short';
    if (side === 'short' && !params.allowShort) {
      return null;
    }

    const stopPrice = resolveStopPrice(side, bar.c, breakingUp ? low : high, atr, params);
    if (stopPrice === null) {
      return null;
    }
    if (side === 'long' ? stopPrice >= bar.c : stopPrice <= bar.c) {
      return null;
    }

    if (ctx.position === null) {
      return { type: 'enter', side, stopPrice, takeProfitR: params.takeProfitR };
    }
    if (ctx.position.side !== side) {
      return { type: 'reverse', side, stopPrice, takeProfitR: params.takeProfitR };
    }
    return null;
  },
};
