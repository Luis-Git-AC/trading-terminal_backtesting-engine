import type { Candle } from '@tt/shared';
import { z } from 'zod';
import { createAtr } from '../engine/indicators/atr.js';
import { fromBar, fromClose } from '../engine/indicators/registry.js';
import { createSma } from '../engine/indicators/sma.js';
import type { BarContext, InitContext, Signal, StrategyDefinition } from '../engine/types.js';

export const TREND = 'trend';
export const PULLBACK = 'pullback';
export const ATR = 'atr';

export const smaPullbackParamsSchema = z
  .object({
    trendPeriod: z.number().int().min(2).max(400).default(50).describe('SMA de tendencia'),
    pullbackPeriod: z.number().int().min(2).max(200).default(10).describe('SMA de retroceso'),
    atrPeriod: z.number().int().min(2).max(100).default(14).describe('Periodo del ATR'),
    atrStopMult: z.number().min(0.1).max(10).default(2).describe('Stop en multiplos de ATR'),
    takeProfitR: z.number().min(0.1).max(20).default(2).describe('Objetivo en multiplos de R'),
    allowShort: z.boolean().default(true).describe('Permitir cortos'),
  })
  .refine((params) => params.trendPeriod > params.pullbackPeriod, {
    error: 'trendPeriod debe ser mayor que pullbackPeriod',
    path: ['trendPeriod'],
  });

export type SmaPullbackParams = z.infer<typeof smaPullbackParamsSchema>;

export interface SmaPullbackState {
  readonly params: SmaPullbackParams;
  previousBelow: boolean | null;
  previousAbove: boolean | null;
}

export const smaPullback: StrategyDefinition<SmaPullbackParams, SmaPullbackState> = {
  id: 'sma-pullback',
  name: 'SMA Pullback',
  version: '1.0.0',
  description: 'Entrada en el retroceso a la SMA rapida en la direccion de la SMA de tendencia',
  paramsSchema: smaPullbackParamsSchema,

  warmupBars: (params: SmaPullbackParams): number =>
    Math.max(params.trendPeriod, params.pullbackPeriod, params.atrPeriod) + 1,

  init: (params: SmaPullbackParams, ctx: InitContext): SmaPullbackState => {
    ctx.indicators.register(TREND, createSma(params.trendPeriod), fromClose);
    ctx.indicators.register(PULLBACK, createSma(params.pullbackPeriod), fromClose);
    ctx.indicators.register(ATR, createAtr(params.atrPeriod), fromBar);
    return { params, previousBelow: null, previousAbove: null };
  },

  onBar: (bar: Candle, state: SmaPullbackState, ctx: BarContext): Signal | null => {
    const { params } = state;
    const trend = ctx.indicators.get(TREND);
    const pullback = ctx.indicators.get(PULLBACK);
    const atr = ctx.indicators.get(ATR);

    if (trend === null || pullback === null || atr === null) {
      state.previousBelow = null;
      state.previousAbove = null;
      return null;
    }

    const isBelow = bar.c < pullback;
    const isAbove = bar.c > pullback;

    const wasBelow = state.previousBelow;
    const wasAbove = state.previousAbove;
    state.previousBelow = isBelow;
    state.previousAbove = isAbove;

    const recoveredUp = wasBelow === true && isAbove && bar.c > trend;
    const lostDown = wasAbove === true && isBelow && bar.c < trend;

    if (!recoveredUp && !lostDown) {
      return null;
    }

    const distance = params.atrStopMult * atr;
    if (distance <= 0) {
      return null;
    }

    const side = recoveredUp ? 'long' : 'short';
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
