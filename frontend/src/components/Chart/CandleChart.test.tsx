import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BacktestTrade, Candle } from '@tt/shared';

vi.mock('lightweight-charts', () => import('@/test/fake-lightweight-charts'));

const { CandleChart } = await import('@/components/Chart/CandleChart');

const fake = await import('@/test/fake-lightweight-charts');
const { FakeEventSource } = await import('@/test/fake-event-source');

const STEP = 60_000;
const START = 1_785_000_000_000;

function makeCandles(count: number, from = START): Candle[] {
  return Array.from({ length: count }, (_, i) => ({
    t: from + i * STEP,
    o: 100 + i,
    h: 101 + i,
    l: 99 + i,
    c: 100.5 + i,
    v: 10 + i,
  }));
}

const TRADE: BacktestTrade = {
  seq: 1,
  side: 'long',
  entryTs: START + 2 * STEP,
  entryPrice: '100',
  exitTs: START + 5 * STEP,
  exitPrice: '110',
  qty: '1',
  fees: '0.1',
  pnlQuote: '9.9',
  pnlR: 1.5,
  exitReason: 'take-profit',
  maeR: -0.2,
  mfeR: 1.8,
};

const LOSER: BacktestTrade = { ...TRADE, seq: 2, pnlR: -1, exitReason: 'stop' };

beforeEach(() => {
  fake.resetFakeCharts();
  FakeEventSource.reset();
});

function renderChart(props: Partial<Parameters<typeof CandleChart>[0]> = {}) {
  return render(
    <CandleChart
      symbol="BTCUSDT"
      timeframe="1m"
      candles={props.candles ?? makeCandles(3)}
      {...props}
    />,
  );
}

describe('CandleChart', () => {
  it('crea el chart con una serie de velas y otra de volumen en el panel inferior', () => {
    renderChart();

    const chart = fake.lastChart();
    expect(chart.series).toHaveLength(2);
    expect(fake.seriesOfKind(chart, 'Candlestick').paneIndex).toBeUndefined();
    expect(fake.seriesOfKind(chart, 'Histogram').paneIndex).toBe(1);
  });

  it('pinta las velas con el tiempo en segundos, no en milisegundos', () => {
    renderChart({ candles: makeCandles(2) });

    const series = fake.seriesOfKind(fake.lastChart(), 'Candlestick');
    expect(series.setDataCalls[0]).toEqual([
      { time: START / 1000, open: 100, high: 101, low: 99, close: 100.5 },
      { time: (START + STEP) / 1000, open: 101, high: 102, low: 100, close: 101.5 },
    ]);
  });

  it('5.000 velas entran en un unico setData, no en 5.000 updates', () => {
    const candles = makeCandles(5000);

    const started = performance.now();
    renderChart({ candles });
    const elapsed = performance.now() - started;

    const series = fake.seriesOfKind(fake.lastChart(), 'Candlestick');
    expect(series.setDataCalls).toHaveLength(1);
    expect(series.setDataCalls[0]).toHaveLength(5000);
    expect(series.updateCalls).toHaveLength(0);
    expect(elapsed).toBeLessThan(1000);
  });

  it('un tick en vivo actualiza la ultima vela sin recargar la serie', () => {
    renderChart({ live: true, sseCtor: FakeEventSource, candles: makeCandles(3) });

    const series = fake.seriesOfKind(fake.lastChart(), 'Candlestick');
    const volume = fake.seriesOfKind(fake.lastChart(), 'Histogram');
    const setDataBefore = series.setDataCalls.length;

    act(() => {
      FakeEventSource.last().emit('candle', {
        t: START + 2 * STEP,
        o: 102,
        h: 108,
        l: 101,
        c: 107,
        v: 42,
        closed: false,
      });
    });

    expect(series.updateCalls).toEqual([
      { time: (START + 2 * STEP) / 1000, open: 102, high: 108, low: 101, close: 107 },
    ]);
    expect(volume.updateCalls).toHaveLength(1);
    expect(series.setDataCalls).toHaveLength(setDataBefore);
  });

  it('sin live no abre ningun stream de velas', () => {
    renderChart({ sseCtor: FakeEventSource });

    expect(FakeEventSource.openCount).toBe(0);
  });

  it('desmontar destruye el chart', () => {
    const { unmount } = renderChart();

    const chart = fake.lastChart();
    expect(chart.removeCalls).toBe(0);

    unmount();

    expect(chart.removeCalls).toBe(1);
  });

  it('desmontar deja de escuchar el rango visible', () => {
    const { unmount } = renderChart({ onLoadOlder: () => undefined });

    const scale = fake.lastChart().timeScale();
    expect(scale.rangeListeners).toHaveLength(1);

    unmount();

    expect(scale.rangeListeners).toHaveLength(0);
  });

  it('los marcadores caen en los timestamps de entrada y salida de cada trade', () => {
    renderChart({ trades: [TRADE] });

    const markers = fake.lastMarkers().setMarkersCalls.at(-1) ?? [];
    expect(markers).toHaveLength(2);
    expect(markers.map((marker) => (marker as { time: number }).time)).toEqual([
      (START + 2 * STEP) / 1000,
      (START + 5 * STEP) / 1000,
    ]);
  });

  it('la salida de un trade perdedor y la de uno ganador no comparten color', () => {
    renderChart({ trades: [TRADE, LOSER] });

    const markers = (fake.lastMarkers().setMarkersCalls.at(-1) ?? []) as {
      time: number;
      color: string;
      text: string;
    }[];

    const winnerExit = markers.find((marker) => marker.text.includes('take-profit'));
    const loserExit = markers.find((marker) => marker.text.includes('stop'));

    expect(winnerExit?.color).not.toBe(loserExit?.color);
    expect(winnerExit?.text).toContain('+1.50R');
    expect(loserExit?.text).toContain('-1.00R');
  });

  it('sin trades no pinta marcadores', () => {
    renderChart();

    expect(fake.lastMarkers().setMarkersCalls.at(-1)).toEqual([]);
  });

  it('al llegar al borde izquierdo pide la pagina anterior una sola vez', () => {
    const onLoadOlder = vi.fn();
    renderChart({ onLoadOlder, candles: makeCandles(50) });

    const scale = fake.lastChart().timeScale();

    act(() => {
      for (const listener of scale.rangeListeners) {
        listener({ from: 2, to: 40 });
        listener({ from: 1, to: 39 });
      }
    });

    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it('no pide nada si el rango visible no llega al borde', () => {
    const onLoadOlder = vi.fn();
    renderChart({ onLoadOlder, candles: makeCandles(50) });

    act(() => {
      for (const listener of fake.lastChart().timeScale().rangeListeners) {
        listener({ from: 25, to: 49 });
      }
    });

    expect(onLoadOlder).not.toHaveBeenCalled();
  });

  it('prepender una pagina desplaza el rango visible para no dar un salto', () => {
    const { rerender } = render(
      <CandleChart symbol="BTCUSDT" timeframe="1m" candles={makeCandles(10, START)} />,
    );

    const chart = fake.lastChart();
    chart.timeScale().visibleLogicalRange = { from: 0, to: 9 };

    const older = makeCandles(5, START - 5 * STEP);
    rerender(
      <CandleChart
        symbol="BTCUSDT"
        timeframe="1m"
        candles={[...older, ...makeCandles(10, START)]}
      />,
    );

    expect(chart.timeScale().setVisibleLogicalRangeCalls).toEqual([{ from: 5, to: 14 }]);
  });

  it('anadir velas nuevas al final no toca el rango visible', () => {
    const { rerender } = render(
      <CandleChart symbol="BTCUSDT" timeframe="1m" candles={makeCandles(10, START)} />,
    );

    const chart = fake.lastChart();
    chart.timeScale().visibleLogicalRange = { from: 0, to: 9 };

    rerender(<CandleChart symbol="BTCUSDT" timeframe="1m" candles={makeCandles(12, START)} />);

    expect(chart.timeScale().setVisibleLogicalRangeCalls).toEqual([]);
  });
});
