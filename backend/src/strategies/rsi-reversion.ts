import type { Candle } from '@tt/shared';
import { z } from 'zod';
import { createAtr } from '../engine/indicators/atr.js';
import { fromBar, fromClose } from '../engine/indicators/registry.js';
import { createRsi } from '../engine/indicators/rsi.js';
import { createSma } from '../engine/indicators/sma.js';
import type { BarContext, InitContext, Signal, StrategyDefinition } from '../engine/types.js';

export const RSI = 'rsi';
export const TREND = 'trend';
export const ATR = 'atr';

export const rsiReversionParamsSchema = z
  .object({
    rsiPeriod: z.number().int().min(2).max(100).default(14).describe('Periodo del RSI'),
    oversold: z.number().min(1).max(49).default(30).describe('Nivel de sobreventa'),
    overbought: z.number().min(51).max(99).default(70).describe('Nivel de sobrecompra'),
    trendPeriod: z.number().int().min(2).max(400).default(200).describe('SMA de tendencia'),
    useTrendFilter: z.boolean().default(true).describe('Filtrar por tendencia'),
    atrPeriod: z.number().int().min(2).max(100).default(14).describe('Periodo del ATR'),
    atrStopMult: z.number().min(0.1).max(10).default(2).describe('Stop en multiplos de ATR'),
    takeProfitR: z.number().min(0.1).max(20).default(2).describe('Objetivo en multiplos de R'),
    allowShort: z.boolean().default(true).describe('Permitir cortos'),
  })
  .refine((params) => params.overbought > params.oversold, {
    error: 'overbought debe ser mayor que oversold',
    path: ['overbought'],
  });

export type RsiReversionParams = z.infer<typeof rsiReversionParamsSchema>;

export interface RsiReversionState {
  readonly params: RsiReversionParams;
  previousRsi: number | null;
}

export const rsiReversion: StrategyDefinition<RsiReversionParams, RsiReversionState> = {
  id: 'rsi-reversion',
  name: 'RSI Reversion',
  version: '1.0.0',
  description: 'Cruce de los niveles de sobreventa y sobrecompra del RSI, con filtro de tendencia',
  paramsSchema: rsiReversionParamsSchema,

  // El RSI de Wilder necesita rsiPeriod variaciones, es decir rsiPeriod + 1 cierres.
  warmupBars: (params: RsiReversionParams): number =>
    Math.max(params.rsiPeriod + 1, params.trendPeriod, params.atrPeriod) + 1,

  init: (params: RsiReversionParams, ctx: InitContext): RsiReversionState => {
    ctx.indicators.register(RSI, createRsi(params.rsiPeriod), fromClose);
    ctx.indicators.register(TREND, createSma(params.trendPeriod), fromClose);
    ctx.indicators.register(ATR, createAtr(params.atrPeriod), fromBar);
    return { params, previousRsi: null };
  },

  onBar: (bar: Candle, state: RsiReversionState, ctx: BarContext): Signal | null => {
    const { params } = state;
    const rsi = ctx.indicators.get(RSI);
    const trend = ctx.indicators.get(TREND);
    const atr = ctx.indicators.get(ATR);

    if (rsi === null || atr === null) {
      state.previousRsi = rsi;
      return null;
    }

    const previous = state.previousRsi;
    state.previousRsi = rsi;

    if (previous === null) {
      return null;
    }

    const crossedUp = previous <= params.oversold && rsi > params.oversold;
    const crossedDown = previous >= params.overbought && rsi < params.overbought;

    if (!crossedUp && !crossedDown) {
      return null;
    }

    const side = crossedUp ? 'long' : 'short';
    if (side === 'short' && !params.allowShort) {
      return null;
    }

    if (params.useTrendFilter) {
      if (trend === null) {
        return null;
      }
      if (side === 'long' ? bar.c <= trend : bar.c >= trend) {
        return null;
      }
    }

    const distance = params.atrStopMult * atr;
    if (distance <= 0) {
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
