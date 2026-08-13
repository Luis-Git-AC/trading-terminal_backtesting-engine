import { useEffect, useRef, useState } from 'react';
import {
  CandlestickSeries,
  HistogramSeries,
  createChart,
  createSeriesMarkers,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type LogicalRange,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { BacktestTrade, Candle, Timeframe } from '@tt/shared';
import type { SseConnectionCtor } from '@/api/event-source';
import { useLiveCandles } from '@/hooks/useLiveCandles';
import { toChartTime, tradeMarkers } from '@/components/Chart/markers';
import { readChartTheme, type ChartTheme } from '@/components/Chart/theme';
import styles from './CandleChart.module.css';

export const LOAD_OLDER_THRESHOLD_BARS = 10;

export interface CandleChartProps {
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly candles: readonly Candle[];
  readonly trades?: readonly BacktestTrade[] | undefined;
  readonly live?: boolean | undefined;
  readonly onLoadOlder?: (() => void) | undefined;
  readonly sseCtor?: SseConnectionCtor | undefined;
}

export function toCandlestickData(candle: Candle): CandlestickData<UTCTimestamp> {
  return {
    time: toChartTime(candle.t),
    open: candle.o,
    high: candle.h,
    low: candle.l,
    close: candle.c,
  };
}

export function toVolumeData(candle: Candle, theme: ChartTheme): HistogramData<UTCTimestamp> {
  return {
    time: toChartTime(candle.t),
    value: candle.v,
    color: candle.c >= candle.o ? theme.up : theme.down,
  };
}

interface ChartRefs {
  chart: IChartApi;
  candles: ISeriesApi<'Candlestick'>;
  volume: ISeriesApi<'Histogram'>;
  markers: ISeriesMarkersPluginApi<Time>;
}

export function CandleChart({
  symbol,
  timeframe,
  candles,
  trades,
  live = false,
  onLoadOlder,
  sseCtor,
}: CandleChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const refsRef = useRef<ChartRefs | null>(null);
  const onLoadOlderRef = useRef(onLoadOlder);
  const oldestTsRef = useRef<number | null>(null);
  const requestedOlderForRef = useRef<number | null>(null);

  const [theme, setTheme] = useState<ChartTheme | null>(null);

  useEffect(() => {
    onLoadOlderRef.current = onLoadOlder;
  });

  useEffect(() => {
    const container = containerRef.current;

    if (container === null) {
      return;
    }

    const resolved = readChartTheme(container);
    setTheme(resolved);

    const chart = createChart(container, {
      layout: {
        background: { color: resolved.bg },
        textColor: resolved.textTertiary,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: resolved.border },
        horzLines: { color: resolved.border },
      },
      rightPriceScale: { borderColor: resolved.border },
      timeScale: { borderColor: resolved.border, timeVisible: true, secondsVisible: false },
      crosshair: { vertLine: { color: resolved.accent }, horzLine: { color: resolved.accent } },
      autoSize: false,
      width: container.clientWidth,
      height: container.clientHeight,
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: resolved.up,
      downColor: resolved.down,
      borderUpColor: resolved.up,
      borderDownColor: resolved.down,
      wickUpColor: resolved.up,
      wickDownColor: resolved.down,
    });

    const volumeSeries = chart.addSeries(
      HistogramSeries,
      { priceFormat: { type: 'volume' }, priceScaleId: '' },
      1,
    );

    const markersPlugin = createSeriesMarkers(candleSeries, []);

    refsRef.current = {
      chart,
      candles: candleSeries,
      volume: volumeSeries,
      markers: markersPlugin,
    };

    const onRangeChange = (range: LogicalRange | null): void => {
      if (range === null || onLoadOlderRef.current === undefined) {
        return;
      }
      if (range.from > LOAD_OLDER_THRESHOLD_BARS) {
        return;
      }
      const oldest = oldestTsRef.current;
      if (oldest === null || requestedOlderForRef.current === oldest) {
        return;
      }
      requestedOlderForRef.current = oldest;
      onLoadOlderRef.current();
    };

    chart.timeScale().subscribeVisibleLogicalRangeChange(onRangeChange);

    const observer = new ResizeObserver(() => {
      chart.resize(container.clientWidth, container.clientHeight);
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRangeChange);
      chart.remove();
      refsRef.current = null;
    };
  }, []);

  useEffect(() => {
    const refs = refsRef.current;

    if (refs === null || theme === null) {
      return;
    }

    const previousOldest = oldestTsRef.current;
    const nextOldest = candles[0]?.t ?? null;

    const before = refs.chart.timeScale().getVisibleLogicalRange();
    const prepended =
      previousOldest !== null && nextOldest !== null && nextOldest < previousOldest
        ? candles.findIndex((candle) => candle.t === previousOldest)
        : 0;

    refs.candles.setData(candles.map(toCandlestickData));
    refs.volume.setData(candles.map((candle) => toVolumeData(candle, theme)));

    oldestTsRef.current = nextOldest;

    if (prepended > 0 && before !== null) {
      refs.chart.timeScale().setVisibleLogicalRange({
        from: before.from + prepended,
        to: before.to + prepended,
      });
    }
  }, [candles, theme]);

  useEffect(() => {
    const refs = refsRef.current;

    if (refs === null || theme === null) {
      return;
    }

    refs.markers.setMarkers(tradeMarkers(trades ?? [], theme));
  }, [trades, theme]);

  useLiveCandles(live ? symbol : undefined, live ? timeframe : undefined, {
    ctor: sseCtor,
    onTick: (candle) => {
      const refs = refsRef.current;
      if (refs === null || theme === null) {
        return;
      }
      refs.candles.update(toCandlestickData(candle));
      refs.volume.update(toVolumeData(candle, theme));
    },
  });

  return <div className={styles.chart} ref={containerRef} data-testid="candle-chart" />;
}
