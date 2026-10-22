import { useEffect, useRef, useState } from 'react';
import {
  CandlestickSeries,
  HistogramSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
  createTextWatermark,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type ITextWatermarkPluginApi,
  type LogicalRange,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { BacktestTrade, Candle, Exchange, Timeframe } from '@tt/shared';
import type { SseConnectionCtor } from '@/api/event-source';
import type { ConnectionState } from '@/hooks/useEventSource';
import { useLiveCandles } from '@/hooks/useLiveCandles';
import { toChartTime, tradeMarkers } from '@/components/Chart/markers';
import { readChartTheme, type ChartTheme } from '@/components/Chart/theme';
import { TradeSpanPrimitive } from '@/components/Chart/trade-span';
import { formatUsd } from '@/lib/format';
import { referenceClose, usePublishLivePrice } from '@/state/live-price';
import styles from './CandleChart.module.css';

export const LOAD_OLDER_THRESHOLD_BARS = 10;

export interface TradeHighlight {
  readonly from: number;
  readonly to: number;
  readonly win: boolean;
}

export interface CandleChartProps {
  readonly exchange: Exchange;
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly candles: readonly Candle[];
  readonly trades?: readonly BacktestTrade[] | undefined;
  readonly live?: boolean | undefined;
  readonly onLoadOlder?: (() => void) | undefined;
  readonly focus?: { readonly from: number; readonly to: number } | undefined;
  readonly highlight?: TradeHighlight | undefined;
  readonly sseCtor?: SseConnectionCtor | undefined;
  readonly onConnectionChange?: ((state: ConnectionState) => void) | undefined;
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
    color: candle.c >= candle.o ? theme.volumeUp : theme.volumeDown,
  };
}

interface ChartRefs {
  chart: IChartApi;
  candles: ISeriesApi<'Candlestick'>;
  volume: ISeriesApi<'Histogram'>;
  markers: ISeriesMarkersPluginApi<Time>;
  watermark: ITextWatermarkPluginApi<Time> | null;
  span: TradeSpanPrimitive;
}

export function themedChartOptions(theme: ChartTheme): Parameters<IChartApi['applyOptions']>[0] {
  const crosshairLine = {
    color: theme.accent,
    style: LineStyle.Dashed,
    labelBackgroundColor: theme.accent,
  };

  return {
    layout: {
      background: { color: theme.bg },
      textColor: theme.textTertiary,
      fontFamily: theme.fontMono,
      attributionLogo: false,
      panes: { separatorColor: theme.border, separatorHoverColor: theme.border },
    },
    grid: {
      vertLines: { color: theme.grid },
      horzLines: { color: theme.grid },
    },
    rightPriceScale: { borderColor: theme.border },
    timeScale: { borderColor: theme.border },
    crosshair: { vertLine: crosshairLine, horzLine: crosshairLine },
  };
}

export function themedCandleOptions(
  theme: ChartTheme,
): Parameters<ISeriesApi<'Candlestick'>['applyOptions']>[0] {
  return {
    upColor: theme.up,
    downColor: theme.down,
    borderUpColor: theme.up,
    borderDownColor: theme.down,
    wickUpColor: theme.up,
    wickDownColor: theme.down,
  };
}

export function watermarkOptions(
  symbol: string,
  timeframe: Timeframe,
  theme: ChartTheme,
): Parameters<ITextWatermarkPluginApi<Time>['applyOptions']>[0] {
  return {
    visible: true,
    horzAlign: 'center',
    vertAlign: 'center',
    lines: [
      {
        text: symbol,
        color: theme.watermark,
        fontSize: 64,
        fontFamily: theme.fontSans,
        fontStyle: '600',
      },
      {
        text: timeframe,
        color: theme.watermark,
        fontSize: 24,
        fontFamily: theme.fontMono,
        fontStyle: '500',
      },
    ],
  };
}

export function CandleChart({
  exchange,
  symbol,
  timeframe,
  candles,
  trades,
  live = false,
  onLoadOlder,
  focus,
  highlight,
  sseCtor,
  onConnectionChange,
}: CandleChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const refsRef = useRef<ChartRefs | null>(null);
  const onLoadOlderRef = useRef(onLoadOlder);
  const oldestTsRef = useRef<number | null>(null);
  const requestedOlderForRef = useRef<number | null>(null);
  const referencePriceRef = useRef<number | null>(null);

  const [theme, setTheme] = useState<ChartTheme | null>(null);

  const publishPrice = usePublishLivePrice();

  const highlightFrom = highlight?.from;
  const highlightTo = highlight?.to;
  const highlightWin = highlight?.win;

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
      ...themedChartOptions(resolved),
      timeScale: { borderColor: resolved.border, timeVisible: true, secondsVisible: false },
      autoSize: false,
      width: container.clientWidth,
      height: container.clientHeight,
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      ...themedCandleOptions(resolved),
      priceFormat: { type: 'custom', minMove: 0.01, formatter: (price: number) => formatUsd(price) },
    });

    const volumeSeries = chart.addSeries(
      HistogramSeries,
      { priceFormat: { type: 'volume' }, priceScaleId: '' },
      1,
    );

    const markersPlugin = createSeriesMarkers(candleSeries, []);

    const pricePane = chart.panes()[0];
    const watermark =
      pricePane === undefined ? null : createTextWatermark(pricePane, { visible: false });

    const span = new TradeSpanPrimitive();
    candleSeries.attachPrimitive(span);

    refsRef.current = {
      chart,
      candles: candleSeries,
      volume: volumeSeries,
      markers: markersPlugin,
      watermark,
      span,
    };

    const themeObserver = new MutationObserver(() => {
      const next = readChartTheme(container);
      chart.applyOptions(themedChartOptions(next));
      candleSeries.applyOptions(themedCandleOptions(next));
      setTheme(next);
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

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
      themeObserver.disconnect();
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
    const last = candles.at(-1);
    referencePriceRef.current = referenceClose(candles);

    if (last !== undefined) {
      publishPrice({ symbol, candle: last, referencePrice: referencePriceRef.current });
    }
  }, [candles, symbol, publishPrice]);

  useEffect(() => {
    const refs = refsRef.current;

    if (refs?.watermark === null || refs?.watermark === undefined || theme === null) {
      return;
    }

    refs.watermark.applyOptions(watermarkOptions(symbol, timeframe, theme));
  }, [symbol, timeframe, theme]);

  useEffect(() => {
    const refs = refsRef.current;

    if (refs === null || theme === null) {
      return;
    }

    refs.markers.setMarkers(tradeMarkers(trades ?? [], theme));
  }, [trades, theme]);

  useEffect(() => {
    const refs = refsRef.current;

    if (refs === null || theme === null) {
      return;
    }

    refs.span.setSpan(
      highlightFrom === undefined || highlightTo === undefined
        ? null
        : {
            from: toChartTime(highlightFrom),
            to: toChartTime(highlightTo),
            fill: highlightWin === true ? theme.spanUp : theme.spanDown,
            edge: highlightWin === true ? theme.up : theme.down,
          },
    );
  }, [highlightFrom, highlightTo, highlightWin, theme]);

  useEffect(() => {
    const refs = refsRef.current;

    if (refs === null || focus === undefined) {
      return;
    }

    refs.chart.timeScale().setVisibleRange({
      from: toChartTime(focus.from),
      to: toChartTime(focus.to),
    });
  }, [focus]);

  const { connectionState } = useLiveCandles(
    live ? exchange : undefined,
    live ? symbol : undefined,
    live ? timeframe : undefined,
    {
      ctor: sseCtor,
      onTick: (candle) => {
        publishPrice({ symbol, candle, referencePrice: referencePriceRef.current });
        const refs = refsRef.current;
        if (refs === null || theme === null) {
          return;
        }
        refs.candles.update(toCandlestickData(candle));
        refs.volume.update(toVolumeData(candle, theme));
      },
    },
  );

  useEffect(() => {
    onConnectionChange?.(connectionState);
  }, [connectionState, onConnectionChange]);

  return <div className={styles.chart} ref={containerRef} data-testid="candle-chart" />;
}
