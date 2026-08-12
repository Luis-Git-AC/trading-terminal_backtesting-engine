import type { Candle } from '@tt/shared';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createSma } from './indicators/sma.js';
import { fromClose } from './indicators/registry.js';
import { InvalidCandleSeriesError, runBacktest } from './run-backtest.js';
import type {
  BacktestInput,
  ExecConfig,
  ProgressEvent,
  Signal,
  StrategyDefinition,
} from './types.js';

const FREE: ExecConfig = {
  initialCapital: 10_000,
  riskPerTradePct: 1,
  feeBps: 0,
  slippageBps: 0,
  fillModel: 'next-open',
};

const paramsSchema = z.object({ warmup: z.number().int().min(0).default(0) });

type Params = z.infer<typeof paramsSchema>;

interface ScriptOptions {
  readonly warmup?: number;
  readonly registers?: boolean;
}

function scripted(
  signalAt: (index: number) => Signal | null,
  options: ScriptOptions = {},
): StrategyDefinition<Params, Record<string, never>> {
  return {
    id: 'scripted',
    name: 'Scripted',
    version: '1.0.0',
    description: 'Estrategia de prueba que emite senales segun un guion',
    paramsSchema,
    warmupBars: (params) => options.warmup ?? params.warmup,
    init: (_params, ctx) => {
      if (options.registers === true) {
        ctx.indicators.register('sma3', createSma(3), fromClose);
      }
      return {};
    },
    onBar: (_bar, _state, ctx) => signalAt(ctx.index),
  };
}

function series(closes: readonly number[], spread = 0.5): Candle[] {
  return closes.map((close, index) => ({
    t: 1_000 + index * 60_000,
    o: close,
    h: close + spread,
    l: close - spread,
    c: close,
    v: 1,
  }));
}

function baseInput(
  candles: readonly Candle[],
  strategy: StrategyDefinition<Params, Record<string, never>>,
  overrides: Partial<BacktestInput<Params, Record<string, never>>> = {},
): BacktestInput<Params, Record<string, never>> {
  return {
    candles,
    strategy,
    params: {},
    exec: FREE,
    seed: 42,
    ...overrides,
  };
}

describe('runBacktest — validacion de la serie', () => {
  it('rechaza velas desordenadas con un error tipado', () => {
    const candles = series([10, 11, 12]);
    const broken = [candles[0], candles[2], candles[1]].filter(
      (bar): bar is Candle => bar !== undefined,
    );
    expect(() => runBacktest(baseInput(broken, scripted(() => null)))).toThrow(
      InvalidCandleSeriesError,
    );
    try {
      runBacktest(baseInput(broken, scripted(() => null)));
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidCandleSeriesError);
      expect(error instanceof InvalidCandleSeriesError ? error.problem : null).toBe('unordered');
    }
  });

  it('rechaza velas duplicadas', () => {
    const candles = series([10, 11]);
    const first = candles[0];
    if (first === undefined) {
      return;
    }
    expect(() => runBacktest(baseInput([first, first], scripted(() => null)))).toThrow(
      /duplicate/,
    );
  });
});

describe('runBacktest — casos vacios', () => {
  it('0 velas devuelve un resultado vacio valido, no una excepcion', () => {
    const result = runBacktest(baseInput([], scripted(() => null)));
    expect(result.trades).toEqual([]);
    expect(result.equityCurve).toEqual([]);
    expect(result.metrics.trades).toBe(0);
    expect(result.metrics.barsTotal).toBe(0);
    expect(result.metrics.exposurePct).toBe(0);
  });

  it('1 vela tampoco rompe nada', () => {
    const result = runBacktest(baseInput(series([10]), scripted(() => null)));
    expect(result.trades).toEqual([]);
    expect(result.metrics.barsTotal).toBe(1);
    expect(result.equityCurve).toHaveLength(1);
    expect(result.equityCurve[0]?.equity).toBe(10_000);
  });

  it('sin trades las metricas son null donde toca y nunca NaN', () => {
    const result = runBacktest(baseInput(series([10, 11, 12, 13]), scripted(() => null)));
    expect(result.metrics.winRate).toBeNull();
    expect(result.metrics.profitFactor).toBeNull();
    expect(result.metrics.expectancyR).toBeNull();
    expect(result.metrics.avgWinR).toBeNull();
    expect(result.metrics.avgLossR).toBeNull();
    expect(result.metrics.largestWinR).toBeNull();
    expect(result.metrics.largestLossR).toBeNull();
    expect(result.metrics.netProfit).toBe(0);
    for (const value of Object.values(result.metrics)) {
      expect(Number.isNaN(value)).toBe(false);
    }
  });
});

describe('runBacktest — ejecucion al open siguiente', () => {
  it('una senal en la barra 3 entra al open de la barra 4', () => {
    const candles = series([100, 101, 102, 103, 107, 108, 109, 110]);
    const result = runBacktest(
      baseInput(
        candles,
        scripted((index) =>
          index === 3 ? { type: 'enter', side: 'long', stopPrice: 90 } : null,
        ),
      ),
    );

    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0];
    expect(trade?.entryTs).toBe(candles[4]?.t);
    expect(trade?.entryPrice).toBe(candles[4]?.o);
  });

  it('no entra nunca en la misma barra en la que se genero la senal', () => {
    const candles = series([100, 101, 102, 103, 104]);
    const result = runBacktest(
      baseInput(
        candles,
        scripted((index) =>
          index === 2 ? { type: 'enter', side: 'long', stopPrice: 90 } : null,
        ),
      ),
    );
    expect(result.trades[0]?.entryTs).not.toBe(candles[2]?.t);
    expect(result.trades[0]?.entryTs).toBe(candles[3]?.t);
  });

  it('una senal en la ultima barra no llega a ejecutarse', () => {
    const candles = series([100, 101, 102]);
    const result = runBacktest(
      baseInput(
        candles,
        scripted((index) =>
          index === 2 ? { type: 'enter', side: 'long', stopPrice: 90 } : null,
        ),
      ),
    );
    expect(result.trades).toHaveLength(0);
    expect(result.metrics.openAtEnd).toBe(false);
  });
});

describe('runBacktest — warmup', () => {
  it('no pide senales antes de warmupBars', () => {
    const seen: number[] = [];
    const strategy = scripted((index) => {
      seen.push(index);
      return null;
    }, { warmup: 5 });
    runBacktest(baseInput(series([1, 2, 3, 4, 5, 6, 7, 8]), strategy));
    expect(seen).toEqual([5, 6, 7]);
  });
});

describe('runBacktest — salidas', () => {
  it('el stop tocado intrabarra cierra al precio del stop', () => {
    const candles: Candle[] = [
      { t: 1, o: 100, h: 101, l: 99, c: 100, v: 1 },
      { t: 2, o: 100, h: 101, l: 99, c: 100, v: 1 },
      { t: 3, o: 100, h: 100, l: 80, c: 85, v: 1 },
    ];
    const result = runBacktest(
      baseInput(
        candles,
        scripted((index) =>
          index === 0 ? { type: 'enter', side: 'long', stopPrice: 90 } : null,
        ),
      ),
    );
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]?.exitReason).toBe('stop');
    expect(result.trades[0]?.exitPrice).toBe(90);
    expect(result.trades[0]?.pnlR).toBe(-1);
  });

  it('una posicion abierta al final se cierra con end-of-data y marca openAtEnd', () => {
    const candles = series([100, 100, 105, 110]);
    const result = runBacktest(
      baseInput(
        candles,
        scripted((index) =>
          index === 0 ? { type: 'enter', side: 'long', stopPrice: 90 } : null,
        ),
      ),
    );
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]?.exitReason).toBe('end-of-data');
    expect(result.trades[0]?.exitPrice).toBe(110);
    expect(result.metrics.openAtEnd).toBe(true);
  });

  it('una senal exit cierra al open de la barra siguiente', () => {
    const candles = series([100, 100, 106, 112]);
    const result = runBacktest(
      baseInput(
        candles,
        scripted((index) => {
          if (index === 0) {
            return { type: 'enter', side: 'long', stopPrice: 90 };
          }
          return index === 1 ? { type: 'exit', reason: 'test' } : null;
        }),
      ),
    );
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]?.exitReason).toBe('signal');
    expect(result.trades[0]?.exitPrice).toBe(candles[2]?.o);
    expect(result.metrics.openAtEnd).toBe(false);
  });

  it('reverse cierra y abre en la misma barra, dejando dos trades', () => {
    const candles = series([100, 100, 106, 112, 118]);
    const result = runBacktest(
      baseInput(
        candles,
        scripted((index) => {
          if (index === 0) {
            return { type: 'enter', side: 'long', stopPrice: 90 };
          }
          return index === 1 ? { type: 'reverse', side: 'short', stopPrice: 130 } : null;
        }),
      ),
    );
    expect(result.trades).toHaveLength(2);
    expect(result.trades[0]?.side).toBe('long');
    expect(result.trades[1]?.side).toBe('short');
    expect(result.trades[0]?.exitTs).toBe(result.trades[1]?.entryTs);
    expect(result.trades[1]?.exitReason).toBe('end-of-data');
  });
});

describe('runBacktest — senales rechazadas', () => {
  it('una distancia al stop de 0 se cuenta como rechazo y no abre posicion', () => {
    const candles = series([100, 100, 100]);
    const result = runBacktest(
      baseInput(
        candles,
        scripted((index) =>
          index === 0 ? { type: 'enter', side: 'long', stopPrice: 100 } : null,
        ),
      ),
    );
    expect(result.rejectedSignals).toBe(1);
    expect(result.trades).toHaveLength(0);
  });

  it('con allowShort en false los cortos se rechazan', () => {
    const candles = series([100, 100, 100]);
    const result = runBacktest(
      baseInput(
        candles,
        scripted((index) =>
          index === 0 ? { type: 'enter', side: 'short', stopPrice: 110 } : null,
        ),
        { exec: { ...FREE, allowShort: false } },
      ),
    );
    expect(result.rejectedSignals).toBe(1);
    expect(result.trades).toHaveLength(0);
  });
});

describe('runBacktest — progreso', () => {
  it('invoca onProgress cada N barras con barsDone monotono', () => {
    const events: ProgressEvent[] = [];
    const onProgress = vi.fn((event: ProgressEvent) => {
      events.push(event);
    });
    runBacktest(
      baseInput(series(Array.from({ length: 25 }, (_, i) => 100 + i)), scripted(() => null), {
        onProgress,
        progressEveryBars: 10,
      }),
    );

    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(events.map((event) => event.barsDone)).toEqual([10, 20]);
    expect(events.every((event) => event.barsTotal === 25)).toBe(true);
  });

  it('el resultado es identico con y sin onProgress', () => {
    const candles = series([100, 100, 106, 112, 118]);
    const build = (): BacktestInput<Params, Record<string, never>> =>
      baseInput(
        candles,
        scripted((index) =>
          index === 0 ? { type: 'enter', side: 'long', stopPrice: 90 } : null,
        ),
      );

    const withProgress = runBacktest({
      ...build(),
      onProgress: () => undefined,
      progressEveryBars: 1,
    });
    const withoutProgress = runBacktest(build());
    expect(withProgress).toEqual(withoutProgress);
  });
});

describe('runBacktest — equity y exposicion', () => {
  it('la curva arranca en el capital inicial y suma un punto por cierre', () => {
    const candles = series([100, 100, 106, 112]);
    const result = runBacktest(
      baseInput(
        candles,
        scripted((index) =>
          index === 0 ? { type: 'enter', side: 'long', stopPrice: 90 } : null,
        ),
      ),
    );
    expect(result.equityCurve[0]?.equity).toBe(10_000);
    expect(result.equityCurve).toHaveLength(2);
    expect(result.equityCurve[1]?.equity).toBe(
      10_000 + (result.trades[0]?.pnlQuote ?? 0),
    );
  });

  it('exposurePct cuenta las barras con posicion abierta', () => {
    const candles = series([100, 100, 106, 112]);
    const result = runBacktest(
      baseInput(
        candles,
        scripted((index) =>
          index === 0 ? { type: 'enter', side: 'long', stopPrice: 90 } : null,
        ),
      ),
    );
    expect(result.metrics.exposurePct).toBe(75);
  });

  it('los indicadores registrados por la estrategia se actualizan una vez por barra', () => {
    const readings: (number | null)[] = [];
    const strategy: StrategyDefinition<Params, Record<string, never>> = {
      ...scripted(() => null, { registers: true }),
      onBar: (_bar, _state, ctx) => {
        readings.push(ctx.indicators.get('sma3'));
        return null;
      },
    };
    runBacktest(baseInput(series([10, 20, 30, 40]), strategy));
    expect(readings).toEqual([null, null, 20, 30]);
  });
});
