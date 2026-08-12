import { describe, expect, it } from 'vitest';
import {
  computeMetrics,
  downsampleEquity,
  drawdownExtremes,
  maxDrawdown,
  type MetricsInput,
} from './metrics.js';
import { mulberry32 } from './prng.js';
import type { EquityPoint, ExecConfig, ExitReason, Side, Trade } from './types.js';

const EXEC: ExecConfig = {
  initialCapital: 10_000,
  riskPerTradePct: 1,
  feeBps: 0,
  slippageBps: 0,
  fillModel: 'next-open',
};

function trade(seq: number, pnlQuote: number, pnlR: number, side: Side = 'long'): Trade {
  const reason: ExitReason = 'signal';
  return {
    seq,
    side,
    entryTs: seq * 1_000,
    entryPrice: 100,
    exitTs: seq * 1_000 + 500,
    exitPrice: 100 + pnlQuote / 10,
    qty: 10,
    fees: 0,
    pnlQuote,
    pnlR,
    exitReason: reason,
    maeR: 0,
    mfeR: 0,
  };
}

function curve(equities: readonly number[]): EquityPoint[] {
  let peak = Number.NEGATIVE_INFINITY;
  return equities.map((equity, index) => {
    peak = Math.max(peak, equity);
    return { t: index * 1_000, equity, drawdown: peak > 0 ? (peak - equity) / peak : 0 };
  });
}

const HAND_TRADES: Trade[] = [
  trade(1, 200, 2),
  trade(2, -100, -1),
  trade(3, 300, 3),
  trade(4, -50, -0.5),
  trade(5, 0, 0),
];

const HAND_CURVE = curve([10_000, 10_200, 10_100, 10_400, 10_350, 10_350]);

function input(overrides: Partial<MetricsInput> = {}): MetricsInput {
  return {
    trades: HAND_TRADES,
    equityCurve: HAND_CURVE,
    exec: EXEC,
    barsTotal: 100,
    barsInPosition: 40,
    openAtEnd: false,
    ...overrides,
  };
}

describe('computeMetrics — conjunto calculado a mano', () => {
  const metrics = computeMetrics(input());

  it('netProfit es la suma de los PnL', () => {
    expect(metrics.netProfit).toBe(350);
    expect(metrics.netProfitPct).toBe(3.5);
  });

  it('el breakeven exacto cuenta como perdida', () => {
    expect(metrics.wins).toBe(2);
    expect(metrics.losses).toBe(3);
    expect(metrics.trades).toBe(5);
  });

  it('winRate es wins/trades', () => {
    expect(metrics.winRate).toBe(0.4);
  });

  it('profitFactor es 500/150', () => {
    expect(metrics.profitFactor).toBe(3.3333333333);
  });

  it('expectancyR es la media aritmetica de pnlR', () => {
    expect(metrics.expectancyR).toBe(0.7);
  });

  it('avgWinR y avgLossR se calculan sobre cada grupo', () => {
    expect(metrics.avgWinR).toBe(2.5);
    expect(metrics.avgLossR).toBe(-0.5);
  });

  it('largestWinR y largestLossR son los extremos', () => {
    expect(metrics.largestWinR).toBe(3);
    expect(metrics.largestLossR).toBe(-1);
  });

  it('maxDrawdown es 100/10200 y su equivalente en quote son 100', () => {
    expect(metrics.maxDrawdown).toBe(0.0098039216);
    expect(metrics.maxDrawdownQuote).toBe(100);
  });

  it('exposurePct es el porcentaje de barras con posicion', () => {
    expect(metrics.exposurePct).toBe(40);
  });
});

describe('computeMetrics — casos degenerados', () => {
  it('sin trades todo lo promediable es null y nada es NaN', () => {
    const metrics = computeMetrics(input({ trades: [], equityCurve: curve([10_000]) }));
    expect(metrics.winRate).toBeNull();
    expect(metrics.profitFactor).toBeNull();
    expect(metrics.expectancyR).toBeNull();
    expect(metrics.avgWinR).toBeNull();
    expect(metrics.avgLossR).toBeNull();
    expect(metrics.largestWinR).toBeNull();
    expect(metrics.largestLossR).toBeNull();
    expect(metrics.netProfit).toBe(0);
    for (const value of Object.values(metrics)) {
      expect(typeof value === 'number' && Number.isNaN(value)).toBe(false);
      expect(value).not.toBe(Number.POSITIVE_INFINITY);
    }
  });

  it('sin perdidas profitFactor es null, no Infinity', () => {
    const metrics = computeMetrics(
      input({ trades: [trade(1, 100, 1), trade(2, 50, 0.5)] }),
    );
    expect(metrics.profitFactor).toBeNull();
    expect(metrics.avgLossR).toBeNull();
    expect(metrics.winRate).toBe(1);
  });

  it('todo perdidas da profitFactor 0 y winRate 0', () => {
    const metrics = computeMetrics(
      input({ trades: [trade(1, -100, -1), trade(2, -50, -0.5)] }),
    );
    expect(metrics.profitFactor).toBe(0);
    expect(metrics.winRate).toBe(0);
    expect(metrics.avgWinR).toBeNull();
    expect(metrics.largestWinR).toBeNull();
  });

  it('0 barras no divide por cero en exposurePct', () => {
    const metrics = computeMetrics(input({ barsTotal: 0, barsInPosition: 0 }));
    expect(metrics.exposurePct).toBe(0);
  });

  it('capital inicial 0 no revienta netProfitPct', () => {
    const metrics = computeMetrics(input({ exec: { ...EXEC, initialCapital: 0 } }));
    expect(metrics.netProfitPct).toBe(0);
  });

  it('propaga openAtEnd', () => {
    expect(computeMetrics(input({ openAtEnd: true })).openAtEnd).toBe(true);
  });
});

describe('maxDrawdown', () => {
  it('una curva monotona creciente no tiene drawdown', () => {
    expect(maxDrawdown(curve([100, 110, 120, 130]))).toEqual({ fraction: 0, quote: 0 });
  });

  it('una curva vacia da 0', () => {
    expect(maxDrawdown([])).toEqual({ fraction: 0, quote: 0 });
  });

  it('el drawdown se mide desde el pico anterior, no desde el inicio', () => {
    expect(maxDrawdown(curve([100, 200, 100]))).toEqual({ fraction: 0.5, quote: 100 });
  });

  it('se queda con el peor de varios drawdowns', () => {
    expect(maxDrawdown(curve([100, 90, 200, 100, 250]))).toEqual({ fraction: 0.5, quote: 100 });
  });

  it('esta acotado en [0, 1]', () => {
    const result = maxDrawdown(curve([100, 50, 25, 1]));
    expect(result.fraction).toBeGreaterThanOrEqual(0);
    expect(result.fraction).toBeLessThanOrEqual(1);
  });
});

describe('drawdownExtremes', () => {
  it('senala el pico y el valle del peor tramo', () => {
    expect(drawdownExtremes(curve([100, 90, 200, 100, 250]))).toEqual({
      peakIndex: 2,
      troughIndex: 3,
    });
  });
});

describe('downsampleEquity', () => {
  it('una curva mas corta que el limite se devuelve intacta', () => {
    const points = curve([1, 2, 3]);
    expect(downsampleEquity(points, 10)).toEqual(points);
  });

  it('respeta el limite de puntos', () => {
    const random = mulberry32(7);
    const points = curve(Array.from({ length: 20_000 }, () => 10_000 + random() * 1_000));
    const reduced = downsampleEquity(points, 500);
    expect(reduced.length).toBeLessThanOrEqual(500);
    expect(reduced.length).toBeGreaterThan(100);
  });

  it('conserva el primer y el ultimo punto', () => {
    const random = mulberry32(9);
    const points = curve(Array.from({ length: 5_000 }, () => 10_000 + random() * 500));
    const reduced = downsampleEquity(points, 200);
    expect(reduced[0]).toEqual(points[0]);
    expect(reduced[reduced.length - 1]).toEqual(points[points.length - 1]);
  });

  it('conserva el punto del max drawdown: la curva reducida da el mismo drawdown', () => {
    const random = mulberry32(11);
    const equities = Array.from({ length: 10_000 }, () => 10_000 + random() * 2_000);
    equities[6_000] = 1;
    const points = curve(equities);
    const reduced = downsampleEquity(points, 300);
    expect(maxDrawdown(reduced)).toEqual(maxDrawdown(points));
  });

  it('mantiene el orden temporal', () => {
    const random = mulberry32(13);
    const points = curve(Array.from({ length: 8_000 }, () => 10_000 + random() * 900));
    const reduced = downsampleEquity(points, 400);
    for (let i = 1; i < reduced.length; i += 1) {
      expect(reduced[i]?.t ?? 0).toBeGreaterThan(reduced[i - 1]?.t ?? 0);
    }
  });

  it('es determinista: dos pasadas dan exactamente lo mismo', () => {
    const random = mulberry32(17);
    const points = curve(Array.from({ length: 6_000 }, () => 10_000 + random() * 700));
    expect(downsampleEquity(points, 250)).toEqual(downsampleEquity(points, 250));
  });

  it('una curva vacia sigue vacia', () => {
    expect(downsampleEquity([], 100)).toEqual([]);
  });
});
