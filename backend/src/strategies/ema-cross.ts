import type { Candle } from '@tt/shared';
import { z } from 'zod';
import { createAtr } from '../engine/indicators/atr.js';
import { createEma } from '../engine/indicators/ema.js';
import { fromBar, fromClose } from '../engine/indicators/registry.js';
import type { BarContext, InitContext, Signal, StrategyDefinition } from '../engine/types.js';

export const EMA_FAST = 'emaFast';
export const EMA_SLOW = 'emaSlow';
export const ATR = 'atr';

export const emaCrossParamsSchema = z
  .object({
    fastPeriod: z.number().int().min(2).max(200).default(12),
    slowPeriod: z.number().int().min(3).max(400).default(26),
    atrPeriod: z.number().int().min(2).max(100).default(14),
    atrStopMult: z.number().min(0.1).max(10).default(2),
    takeProfitR: z.number().min(0.1).max(20).default(2),
    allowShort: z.boolean().default(true),
  })
  .refine((params) => params.slowPeriod > params.fastPeriod, {
    error: 'slowPeriod debe ser mayor que fastPeriod',
    path: ['slowPeriod'],
  });

export type EmaCrossParams = z.infer<typeof emaCrossParamsSchema>;

export interface EmaCrossState {
  readonly params: EmaCrossParams;
  previousFast: number | null;
  previousSlow: number | null;
}

type Cross = 'bullish' | 'bearish' | null;

function detectCross(
  previousFast: number | null,
  previousSlow: number | null,
  fast: number,
  slow: number,
): Cross {
  if (previousFast === null || previousSlow === null) {
    return null;
  }
  if (previousFast <= previousSlow && fast > slow) {
    return 'bullish';
  }
  if (previousFast >= previousSlow && fast < slow) {
    return 'bearish';
  }
  return null;
}

export const emaCross: StrategyDefinition<EmaCrossParams, EmaCrossState> = {
  id: 'ema-cross',
  name: 'EMA Cross',
  version: '1.0.0',
  description: 'Cruce de EMA rapida sobre lenta con stop por ATR',
  paramsSchema: emaCrossParamsSchema,

  warmupBars: (params: EmaCrossParams): number =>
    Math.max(params.slowPeriod, params.atrPeriod) + 1,

  init: (params: EmaCrossParams, ctx: InitContext): EmaCrossState => {
    ctx.indicators.register(EMA_FAST, createEma(params.fastPeriod), fromClose);
    ctx.indicators.register(EMA_SLOW, createEma(params.slowPeriod), fromClose);
    ctx.indicators.register(ATR, createAtr(params.atrPeriod), fromBar);
    return { params, previousFast: null, previousSlow: null };
  },

  onBar: (bar: Candle, state: EmaCrossState, ctx: BarContext): Signal | null => {
    const { params } = state;
    const fast = ctx.indicators.get(EMA_FAST);
    const slow = ctx.indicators.get(EMA_SLOW);
    const atr = ctx.indicators.get(ATR);

    if (fast === null || slow === null || atr === null) {
      state.previousFast = fast;
      state.previousSlow = slow;
      return null;
    }

    const cross = detectCross(state.previousFast, state.previousSlow, fast, slow);
    state.previousFast = fast;
    state.previousSlow = slow;

    if (cross === null) {
      return null;
    }

    const distance = params.atrStopMult * atr;
    if (distance <= 0) {
      return null;
    }

    if (cross === 'bullish') {
      const stopPrice = bar.c - distance;
      if (ctx.position === null) {
        return { type: 'enter', side: 'long', stopPrice, takeProfitR: params.takeProfitR };
      }
      if (ctx.position.side === 'short') {
        return { type: 'reverse', side: 'long', stopPrice, takeProfitR: params.takeProfitR };
      }
      return null;
    }

    const stopPrice = bar.c + distance;
    if (!params.allowShort) {
      return ctx.position !== null && ctx.position.side === 'long'
        ? { type: 'exit', reason: 'cruce-contrario' }
        : null;
    }
    if (ctx.position === null) {
      return { type: 'enter', side: 'short', stopPrice, takeProfitR: params.takeProfitR };
    }
    if (ctx.position.side === 'long') {
      return { type: 'reverse', side: 'short', stopPrice, takeProfitR: params.takeProfitR };
    }
    return null;
  },
};
