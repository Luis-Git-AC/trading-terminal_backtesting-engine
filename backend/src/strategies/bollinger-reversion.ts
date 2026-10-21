import type { Candle } from '@tt/shared';
import { z } from 'zod';
import { createAtr } from '../engine/indicators/atr.js';
import { fromBar, fromClose } from '../engine/indicators/registry.js';
import { createSma } from '../engine/indicators/sma.js';
import { createStdDev } from '../engine/indicators/stddev.js';
import type { BarContext, InitContext, Signal, StrategyDefinition } from '../engine/types.js';

export const BASIS = 'basis';
export const DEV = 'dev';
export const ATR = 'atr';

export const bollingerReversionParamsSchema = z.object({
  period: z.number().int().min(2).max(200).default(20).describe('Periodo de la media'),
  stdMult: z.number().min(0.1).max(5).default(2).describe('Anchura en desviaciones'),
  atrPeriod: z.number().int().min(2).max(100).default(14).describe('Periodo del ATR'),
  atrStopMult: z.number().min(0.1).max(10).default(2).describe('Stop en multiplos de ATR'),
  takeProfitR: z.number().min(0.1).max(20).default(2).describe('Objetivo en multiplos de R'),
  allowShort: z.boolean().default(true).describe('Permitir cortos'),
});

export type BollingerReversionParams = z.infer<typeof bollingerReversionParamsSchema>;

export interface BollingerReversionState {
  readonly params: BollingerReversionParams;
  previousBelowLower: boolean | null;
  previousAboveUpper: boolean | null;
}

export const bollingerReversion: StrategyDefinition<
  BollingerReversionParams,
  BollingerReversionState
> = {
  id: 'bollinger-reversion',
  name: 'Bollinger Reversion',
  version: '1.0.0',
  description: 'Reversion a la media al volver a entrar en la banda de Bollinger, con stop por ATR',
  paramsSchema: bollingerReversionParamsSchema,

  warmupBars: (params: BollingerReversionParams): number =>
    Math.max(params.period, params.atrPeriod) + 1,

  init: (params: BollingerReversionParams, ctx: InitContext): BollingerReversionState => {
    ctx.indicators.register(BASIS, createSma(params.period), fromClose);
    ctx.indicators.register(DEV, createStdDev(params.period), fromClose);
    ctx.indicators.register(ATR, createAtr(params.atrPeriod), fromBar);
    return { params, previousBelowLower: null, previousAboveUpper: null };
  },

  onBar: (bar: Candle, state: BollingerReversionState, ctx: BarContext): Signal | null => {
    const { params } = state;
    const basis = ctx.indicators.get(BASIS);
    const dev = ctx.indicators.get(DEV);
    const atr = ctx.indicators.get(ATR);

    if (basis === null || dev === null || atr === null) {
      state.previousBelowLower = null;
      state.previousAboveUpper = null;
      return null;
    }

    const upper = basis + params.stdMult * dev;
    const lower = basis - params.stdMult * dev;
    const isBelow = bar.c < lower;
    const isAbove = bar.c > upper;

    const wasBelow = state.previousBelowLower;
    const wasAbove = state.previousAboveUpper;
    state.previousBelowLower = isBelow;
    state.previousAboveUpper = isAbove;

    const reenteredFromBelow = wasBelow === true && !isBelow;
    const reenteredFromAbove = wasAbove === true && !isAbove;

    if (!reenteredFromBelow && !reenteredFromAbove) {
      return null;
    }

    const distance = params.atrStopMult * atr;
    if (distance <= 0) {
      return null;
    }

    const side = reenteredFromBelow ? 'long' : 'short';
    if (side === 'short' && !params.allowShort) {
      return null;
    }

    const stopPrice = side === 'long' ? bar.c - distance : bar.c + distance;

    if (ctx.position === null) {
      return { type: 'enter', side, stopPrice, takeProfitR: params.takeProfitR };
    }
    if (ctx.position.side !== side) {
      return { type: 'reverse', side, stopPrice, takeProfitR: params.takeProfitR };
    }
    return null;
  },
};
