import type { Candle } from '@tt/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { getStrategy } from '../../strategies/registry.js';
import { fromClose } from '../indicators/registry.js';
import { createSma } from '../indicators/sma.js';
import { runBacktest } from '../run-backtest.js';
import type { ExecConfig, StrategyDefinition } from '../types.js';

const FREE: ExecConfig = {
  initialCapital: 10_000,
  riskPerTradePct: 1,
  feeBps: 0,
  slippageBps: 0,
  fillModel: 'next-open',
};

const START = Date.UTC(2026, 0, 5);
const HOUR = 3_600_000;

const paramsSchema = z.object({});

function series(count: number): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const c = 100 + 8 * Math.sin(i / 9) + 3 * Math.sin(i / 3) + i * 0.02;
    return { t: START + i * HOUR, o: c - 0.2, h: c + 1, l: c - 1, c, v: 1 };
  });
}

function alwaysIn(readings: number[]): StrategyDefinition<Record<string, never>, null> {
  return {
    id: 'always-in',
    name: 'Always in',
    version: '1.0.0',
    description: 'Entra siempre que puede',
    paramsSchema,
    warmupBars: () => 0,
    init: (_params, ctx) => {
      ctx.indicators.register('sma3', createSma(3), fromClose);
      return null;
    },
    onBar: (bar, _state, ctx) => {
      readings.push(ctx.indicators.get('sma3') ?? Number.NaN);
      if (ctx.position !== null) return { type: 'exit', reason: 'guion' };
      return { type: 'enter', side: 'long', stopPrice: bar.c * 0.5 };
    },
  };
}

function holdFrom(entryBar: number): StrategyDefinition<Record<string, never>, { seen: number }> {
  return {
    id: 'hold',
    name: 'Hold',
    version: '1.0.0',
    description: 'Entra una vez y no sale',
    paramsSchema,
    warmupBars: () => 0,
    init: () => ({ seen: 0 }),
    onBar: (bar, state) => {
      state.seen += 1;
      return state.seen === entryBar
        ? { type: 'enter', side: 'long', stopPrice: bar.c * 0.01 }
        : null;
    },
  };
}

const WINDOWS = [
  { from: START + 10 * HOUR, to: START + 14 * HOUR },
  { from: START + 30 * HOUR, to: START + 31 * HOUR },
];

const inWindow = (ts: number) => WINDOWS.some((w) => w.from <= ts && ts <= w.to);

describe('blockedWindows', () => {
  it('ninguna entrada cae dentro de una ventana bloqueada', () => {
    const candles = series(48);
    const libre = runBacktest({ candles, strategy: alwaysIn([]), params: {}, exec: FREE, seed: 1 });
    const bloqueado = runBacktest({
      candles,
      strategy: alwaysIn([]),
      params: {},
      exec: { ...FREE, blockedWindows: WINDOWS },
      seed: 1,
    });

    expect(libre.trades.some((trade) => inWindow(trade.entryTs))).toBe(true);
    expect(bloqueado.trades.length).toBeGreaterThan(0);
    expect(bloqueado.trades.some((trade) => inWindow(trade.entryTs))).toBe(false);
    expect(bloqueado.rejectedSignals).toBeGreaterThan(libre.rejectedSignals);
  });

  it('los indicadores dan el mismo valor con y sin ventanas: no se quitan velas', () => {
    const candles = series(48);
    const sin: number[] = [];
    const con: number[] = [];
    runBacktest({ candles, strategy: alwaysIn(sin), params: {}, exec: FREE, seed: 1 });
    const result = runBacktest({
      candles,
      strategy: alwaysIn(con),
      params: {},
      exec: { ...FREE, blockedWindows: WINDOWS },
      seed: 1,
    });

    expect(con).toEqual(sin);
    expect(sin).toHaveLength(48);
    expect(result.metrics.barsTotal).toBe(48);
  });

  it('una posicion abierta antes de la ventana no se cierra al entrar en ella', () => {
    const candles = series(48);
    const result = runBacktest({
      candles,
      strategy: holdFrom(5),
      params: {},
      exec: { ...FREE, blockedWindows: [{ from: START + 8 * HOUR, to: START + 40 * HOUR }] },
      seed: 1,
    });

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]?.exitReason).toBe('end-of-data');
    expect(result.trades[0]?.entryTs).toBe(START + 5 * HOUR);
  });

  it('con blockedWindows vacio el resultado es identico al de sin el campo', () => {
    const candles = series(2_000);
    for (const id of ['ema-cross', 'rsi-reversion', 'bollinger-reversion', 'sma-pullback']) {
      const strategy = getStrategy(id);
      const antes = runBacktest({ candles, strategy, params: {}, exec: FREE, seed: 42 });
      const ahora = runBacktest({
        candles,
        strategy,
        params: {},
        exec: { ...FREE, blockedWindows: [] },
        seed: 42,
      });
      expect(JSON.stringify(ahora)).toBe(JSON.stringify(antes));
    }
  });
});
