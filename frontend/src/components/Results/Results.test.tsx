import { act, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BacktestMetricsResponse, BacktestTrade } from '@tt/shared';
import { EquityChart, formatAxisDate, toEquityView } from '@/components/Results/EquityChart';
import { MetricsGrid } from '@/components/Results/MetricsGrid';
import { TradesTable } from '@/components/Results/TradesTable';
import { EMPTY_VALUE, metricCards, nullHint, signOf } from '@/components/Results/metrics';
import { nextSort, pageCount, pageOf, sortTrades, tradeRange } from '@/components/Results/trades';

const METRICS: BacktestMetricsResponse = {
  netProfit: '1843.21',
  netProfitPct: 18.43,
  maxDrawdown: 0.121,
  maxDrawdownQuote: '1204.55',
  winRate: 0.42,
  profitFactor: 1.61,
  expectancyR: 0.23,
  trades: 137,
  wins: 58,
  losses: 79,
  avgWinR: 1.82,
  avgLossR: -0.98,
  largestWinR: 5.1,
  largestLossR: -1,
  exposurePct: 34.2,
  barsTotal: 17_472,
  openAtEnd: false,
};

const START = 1_785_000_000_000;
const HOUR = 3_600_000;

function trade(seq: number, overrides: Partial<BacktestTrade> = {}): BacktestTrade {
  return {
    seq,
    side: 'long',
    entryTs: START + seq * HOUR,
    entryPrice: '100',
    exitTs: START + seq * HOUR + HOUR,
    exitPrice: '110',
    qty: '1',
    fees: '0.1',
    pnlQuote: '9.9',
    pnlR: seq % 2 === 0 ? 1.5 : -0.8,
    exitReason: seq % 2 === 0 ? 'take-profit' : 'stop',
    maeR: -0.2,
    mfeR: 1.8,
    ...overrides,
  };
}

describe('metricCards', () => {
  it('muestra exactamente lo que devuelve el API, sin recalcular', () => {
    const cards = metricCards(METRICS);
    const byKey = new Map(cards.map((card) => [card.key, card.value]));

    expect(byKey.get('netProfit')).toBe('1.843,21');
    expect(byKey.get('netProfitPct')).toBe('18,43%');
    expect(byKey.get('profitFactor')).toBe('1,61');
    expect(byKey.get('expectancyR')).toBe('0,23');
    expect(byKey.get('trades')).toBe('137');
    expect(byKey.get('wins')).toBe('58');
    expect(byKey.get('losses')).toBe('79');
    expect(byKey.get('barsTotal')).toBe('17.472');
  });

  it('cubre todas las metricas del contrato salvo la bandera openAtEnd', () => {
    const keys = metricCards(METRICS).map((card) => card.key);
    const expected = Object.keys(METRICS).filter((key) => key !== 'openAtEnd');

    expect([...keys].sort()).toEqual([...expected].sort());
  });

  it('profitFactor null se muestra como raya, nunca Infinity ni NaN', () => {
    const cards = metricCards({ ...METRICS, profitFactor: null });
    const card = cards.find((item) => item.key === 'profitFactor');

    expect(card?.value).toBe(EMPTY_VALUE);
    expect(card?.value).not.toContain('Infinity');
    expect(card?.value).not.toContain('NaN');
    expect(card?.hint).toContain('perdedoras');
  });

  it('todas las metricas anulables aguantan null a la vez sin producir NaN', () => {
    const cards = metricCards({
      ...METRICS,
      trades: 0,
      wins: 0,
      losses: 0,
      winRate: null,
      profitFactor: null,
      expectancyR: null,
      avgWinR: null,
      avgLossR: null,
      largestWinR: null,
      largestLossR: null,
    });

    for (const card of cards) {
      expect(card.value).not.toContain('NaN');
      expect(card.value).not.toContain('Infinity');
    }
    expect(cards.find((card) => card.key === 'winRate')?.hint).toContain('ninguna operacion');
  });

  it('el signo distingue ganancias de perdidas', () => {
    expect(signOf('1843.21')).toBe(1);
    expect(signOf('-10')).toBe(-1);
    expect(signOf('0')).toBe(0);
    expect(signOf(null)).toBe(0);
  });

  it('el motivo del null explica el caso concreto', () => {
    expect(nullHint('avgWinR', METRICS)).toContain('ganadoras');
    expect(nullHint('avgLossR', METRICS)).toContain('perdedoras');
  });
});

describe('MetricsGrid', () => {
  it('pinta el valor junto a su etiqueta', () => {
    render(<MetricsGrid metrics={METRICS} />);

    expect(screen.getByText('Beneficio neto')).toBeDefined();
    expect(screen.getByText('1.843,21')).toBeDefined();
  });

  it('la raya del null lleva un title que lo explica', () => {
    render(<MetricsGrid metrics={{ ...METRICS, profitFactor: null }} />);

    const empty = screen.getAllByText(EMPTY_VALUE);
    expect(empty.length).toBeGreaterThan(0);
    expect(empty[0]?.getAttribute('title')).toContain('perdedoras');
  });

  it('avisa si el run acabo con posicion abierta', () => {
    render(<MetricsGrid metrics={{ ...METRICS, openAtEnd: true }} />);

    expect(screen.getByText(/posicion abierta/i)).toBeDefined();
  });
});

describe('EquityChart', () => {
  it('convierte el equity string y el drawdown a numeros para el grafico', () => {
    const view = toEquityView([
      { t: START, equity: '10000.0000000000', dd: 0 },
      { t: START + HOUR, equity: '10123.4000000000', dd: 0.0212 },
    ]);

    expect(view).toEqual([
      { t: START, equity: 10_000, drawdownPct: 0 },
      { t: START + HOUR, equity: 10_123.4, drawdownPct: 2.12 },
    ]);
  });

  it('sin puntos lo dice en vez de pintar un grafico vacio', () => {
    render(<EquityChart points={[]} />);

    expect(screen.getByText(/no dejo curva/i)).toBeDefined();
    expect(screen.queryByTestId('equity-chart')).toBeNull();
  });

  it('con puntos monta el contenedor del grafico', () => {
    render(<EquityChart points={[{ t: START, equity: '10000', dd: 0 }]} />);

    expect(screen.getByTestId('equity-chart')).toBeDefined();
  });

  it('el eje temporal se formatea en UTC', () => {
    expect(formatAxisDate(Date.parse('2026-03-02T23:30:00.000Z'))).toContain('02');
  });
});

describe('sortTrades', () => {
  const trades = [trade(1), trade(2), trade(3)];

  it('ordena por numero de operacion', () => {
    expect(sortTrades(trades, { key: 'seq', direction: 'desc' }).map((t) => t.seq)).toEqual([
      3, 2, 1,
    ]);
  });

  it('ordena por R', () => {
    expect(sortTrades(trades, { key: 'pnlR', direction: 'desc' }).map((t) => t.pnlR)).toEqual([
      1.5, -0.8, -0.8,
    ]);
  });

  it('ordena por fecha de entrada', () => {
    expect(sortTrades(trades, { key: 'entryTs', direction: 'asc' }).map((t) => t.seq)).toEqual([
      1, 2, 3,
    ]);
  });

  it('no muta el array original', () => {
    const original = [trade(3), trade(1)];
    sortTrades(original, { key: 'seq', direction: 'asc' });

    expect(original.map((t) => t.seq)).toEqual([3, 1]);
  });

  it('el mismo campo alterna direccion y otro campo empieza por su default', () => {
    expect(nextSort({ key: 'seq', direction: 'asc' }, 'seq')).toEqual({
      key: 'seq',
      direction: 'desc',
    });
    expect(nextSort({ key: 'seq', direction: 'asc' }, 'pnlR')).toEqual({
      key: 'pnlR',
      direction: 'desc',
    });
  });
});

describe('paginacion', () => {
  it('reparte en paginas y acota los indices fuera de rango', () => {
    const items = Array.from({ length: 120 }, (_, i) => i);

    expect(pageCount(120, 50)).toBe(3);
    expect(pageOf(items, 0, 50)).toHaveLength(50);
    expect(pageOf(items, 2, 50)).toHaveLength(20);
    expect(pageOf(items, 99, 50)).toEqual(pageOf(items, 2, 50));
    expect(pageOf(items, -3, 50)).toEqual(pageOf(items, 0, 50));
  });

  it('una lista vacia sigue teniendo una pagina', () => {
    expect(pageCount(0, 50)).toBe(1);
  });
});

describe('TradesTable', () => {
  it('con 500 operaciones solo pinta una pagina', () => {
    const many = Array.from({ length: 500 }, (_, i) => trade(i + 1));

    const started = performance.now();
    render(<TradesTable trades={many} />);
    const elapsed = performance.now() - started;

    expect(screen.getAllByRole('row')).toHaveLength(51);
    expect(screen.getByText(/1 \/ 10 · 500 operaciones/)).toBeDefined();
    expect(elapsed).toBeLessThan(1000);
  });

  it('pasar de pagina muestra las siguientes operaciones', () => {
    const many = Array.from({ length: 120 }, (_, i) => trade(i + 1));
    render(<TradesTable trades={many} pageSize={50} />);

    expect(screen.getByText('1')).toBeDefined();

    act(() => {
      screen.getByRole('button', { name: 'Siguiente' }).click();
    });

    expect(screen.getByText('51')).toBeDefined();
    expect(screen.queryByText('1')).toBeNull();
  });

  it('ordenar por R reordena las filas visibles', () => {
    render(<TradesTable trades={[trade(1), trade(2)]} />);

    act(() => {
      screen.getByRole('button', { name: /PnL/ }).click();
    });

    const rows = screen.getAllByRole('row').slice(1);
    expect(within(rows[0]!).getByText('+1.50')).toBeDefined();
  });

  it('muestra el motivo de salida de cada operacion', () => {
    render(<TradesTable trades={[trade(1), trade(2)]} />);

    expect(screen.getByText('stop')).toBeDefined();
    expect(screen.getByText('take-profit')).toBeDefined();
  });

  it('hacer click en una fila entrega el trade al contenedor', () => {
    const onSelect = vi.fn();
    render(<TradesTable trades={[trade(1), trade(2)]} onSelect={onSelect} />);

    act(() => {
      screen.getAllByRole('row').slice(1)[0]?.click();
    });

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]?.[0]).toMatchObject({ seq: 1 });
  });

  it('sin operaciones lo dice', () => {
    render(<TradesTable trades={[]} />);

    expect(screen.getByText(/no cerro ninguna operacion/i)).toBeDefined();
  });

  it('si el API devolvio menos de las que tiene el run, lo dice en vez de mentir', () => {
    const page = Array.from({ length: 500 }, (_, i) => trade(i + 1));
    render(<TradesTable trades={page} totalTrades={2311} />);

    expect(screen.getByText(/500 primeras de 2311/i)).toBeDefined();
  });

  it('si estan todas no avisa de nada', () => {
    render(<TradesTable trades={[trade(1), trade(2)]} totalTrades={2} />);

    expect(screen.queryByText(/primeras de/i)).toBeNull();
  });
});

describe('tradeRange', () => {
  it('centra el rango del trade con margen a los lados', () => {
    expect(tradeRange(trade(1), 60_000)).toEqual({
      from: START + HOUR - 60_000,
      to: START + 2 * HOUR + 60_000,
    });
  });
});
