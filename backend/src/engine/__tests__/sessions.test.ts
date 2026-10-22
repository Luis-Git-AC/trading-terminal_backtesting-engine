import type { Candle } from '@tt/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createSma } from '../indicators/sma.js';
import { fromClose } from '../indicators/registry.js';
import { runBacktest } from '../run-backtest.js';
import type { BacktestInput, ExecConfig, StrategyDefinition } from '../types.js';

const FREE: ExecConfig = {
  initialCapital: 10_000,
  riskPerTradePct: 1,
  feeBps: 0,
  slippageBps: 0,
  fillModel: 'next-open',
};

const paramsSchema = z.object({});

type Params = z.infer<typeof paramsSchema>;

/** Alterna entrada y salida y guarda la SMA vela a vela para compararla. */
function alwaysIn(readings: number[]): StrategyDefinition<Params, Record<string, never>> {
  return {
    id: 'always-in',
    name: 'Always in',
    version: '1.0.0',
    description: 'Entra siempre que pueda; sirve para contar entradas',
    paramsSchema,
    warmupBars: () => 0,
    init: (_params, ctx) => {
      ctx.indicators.register('sma3', createSma(3), fromClose);
      return {};
    },
    onBar: (bar, _state, ctx) => {
      readings.push(ctx.indicators.get('sma3') ?? Number.NaN);
      if (ctx.position !== null) return { type: 'exit', reason: 'guion' };
      return { type: 'enter', side: 'long', stopPrice: bar.c * 0.5 };
    },
  };
}

/** Lunes 00:00 UTC + una vela por hora: las 24 primeras caen en sesion de metales. */
const MONDAY = Date.UTC(2026, 9, 19, 0, 0, 0);
const HOUR = 3_600_000;

function hourlySeries(count: number, mark: (ts: number) => boolean): Candle[] {
  return Array.from({ length: count }, (_, index) => {
    const ts = MONDAY + index * HOUR;
    const close = 100 + index;
    const bar: Candle = { t: ts, o: close, h: close + 1, l: close - 1, c: close, v: 1 };
    return mark(ts) ? { ...bar, x: true } : bar;
  });
}

/** Marca como fuera de sesion la mitad de la serie, a partir de la vela 12. */
const outOfSessionFrom = (index: number) => (ts: number) => ts >= MONDAY + index * HOUR;

function input(
  candles: readonly Candle[],
  strategy: StrategyDefinition<Params, Record<string, never>>,
  exec: ExecConfig,
): BacktestInput<Params, Record<string, never>> {
  return { candles, strategy, params: {}, exec, seed: 42 };
}

describe('excludeOutOfSession', () => {
  it('con la bandera activada no hay ninguna entrada fuera de sesion', () => {
    const candles = hourlySeries(24, outOfSessionFrom(12));
    const result = runBacktest(
      input(candles, alwaysIn([]), { ...FREE, excludeOutOfSession: true }),
    );

    const marked = new Set(candles.filter((bar) => bar.x === true).map((bar) => bar.t));
    expect(marked.size).toBe(12);
    expect(result.trades.length).toBeGreaterThan(0);
    for (const trade of result.trades) {
      expect(marked.has(trade.entryTs)).toBe(false);
    }
  });

  it('sin la bandera, las mismas velas si dan entradas fuera de sesion', () => {
    const candles = hourlySeries(24, outOfSessionFrom(12));
    const abierto = runBacktest(input(candles, alwaysIn([]), FREE));
    const marked = new Set(candles.filter((bar) => bar.x === true).map((bar) => bar.t));

    expect(abierto.trades.some((trade) => marked.has(trade.entryTs))).toBe(true);
  });

  it('las senales descartadas por sesion se cuentan en rejectedSignals', () => {
    const candles = hourlySeries(24, outOfSessionFrom(12));
    const abierto = runBacktest(input(candles, alwaysIn([]), FREE));
    const cerrado = runBacktest(
      input(candles, alwaysIn([]), { ...FREE, excludeOutOfSession: true }),
    );

    expect(cerrado.rejectedSignals).toBeGreaterThan(abierto.rejectedSignals);
  });

  it('los indicadores dan el mismo valor con la bandera activada y desactivada', () => {
    const candles = hourlySeries(24, outOfSessionFrom(12));
    const sinBandera: number[] = [];
    const conBandera: number[] = [];

    runBacktest(input(candles, alwaysIn(sinBandera), FREE));
    runBacktest(input(candles, alwaysIn(conBandera), { ...FREE, excludeOutOfSession: true }));

    expect(conBandera).toEqual(sinBandera);
    expect(sinBandera).toHaveLength(24);
  });

  it('la serie llega completa al motor: la bandera no quita velas', () => {
    const candles = hourlySeries(24, outOfSessionFrom(12));
    const readings: number[] = [];
    const result = runBacktest(
      input(candles, alwaysIn(readings), { ...FREE, excludeOutOfSession: true }),
    );

    // 24 barras contadas y 24 pasadas por la estrategia: nadie recorta la serie.
    expect(result.metrics.barsTotal).toBe(24);
    expect(readings).toHaveLength(24);
  });

  it('con la bandera a false las metricas son identicas a las de una serie sin marcar', () => {
    const marcada = hourlySeries(24, outOfSessionFrom(12));
    const limpia = hourlySeries(24, () => false);

    const conMarca = runBacktest(input(marcada, alwaysIn([]), FREE));
    const sinMarca = runBacktest(input(limpia, alwaysIn([]), FREE));

    expect(conMarca.metrics).toEqual(sinMarca.metrics);
    expect(conMarca.trades).toEqual(sinMarca.trades);
    expect(conMarca.equityCurve).toEqual(sinMarca.equityCurve);
  });

  it('una serie crypto (sin marcas) no cambia con la bandera activada', () => {
    const candles = hourlySeries(24, () => false);

    const abierto = runBacktest(input(candles, alwaysIn([]), FREE));
    const cerrado = runBacktest(
      input(candles, alwaysIn([]), { ...FREE, excludeOutOfSession: true }),
    );

    expect(cerrado.metrics).toEqual(abierto.metrics);
    expect(cerrado.trades).toEqual(abierto.trades);
  });
});
