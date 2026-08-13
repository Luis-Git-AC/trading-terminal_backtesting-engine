export interface FakeSeries {
  readonly kind: string;
  readonly paneIndex: number | undefined;
  readonly setDataCalls: unknown[][];
  readonly updateCalls: unknown[];
  setData(data: unknown[]): void;
  update(point: unknown): void;
}

export interface FakeMarkersPlugin {
  readonly setMarkersCalls: unknown[][];
  setMarkers(markers: unknown[]): void;
}

export interface FakeTimeScale {
  visibleLogicalRange: { from: number; to: number } | null;
  readonly setVisibleRangeCalls: { from: number; to: number }[];
  setVisibleRange(range: { from: number; to: number }): void;
  readonly setVisibleLogicalRangeCalls: { from: number; to: number }[];
  readonly rangeListeners: ((range: { from: number; to: number } | null) => void)[];
  getVisibleLogicalRange(): { from: number; to: number } | null;
  setVisibleLogicalRange(range: { from: number; to: number }): void;
  subscribeVisibleLogicalRangeChange(
    listener: (range: { from: number; to: number } | null) => void,
  ): void;
  unsubscribeVisibleLogicalRangeChange(
    listener: (range: { from: number; to: number } | null) => void,
  ): void;
}

export interface FakeChart {
  readonly container: unknown;
  readonly options: unknown;
  readonly series: FakeSeries[];
  removeCalls: number;
  resizeCalls: [number, number][];
  addSeries(definition: { kind: string }, options?: unknown, paneIndex?: number): FakeSeries;
  timeScale(): FakeTimeScale;
  resize(width: number, height: number): void;
  remove(): void;
}

export const CandlestickSeries = { kind: 'Candlestick' } as const;
export const HistogramSeries = { kind: 'Histogram' } as const;

export const charts: FakeChart[] = [];
export const markerPlugins: FakeMarkersPlugin[] = [];

export function resetFakeCharts(): void {
  charts.length = 0;
  markerPlugins.length = 0;
}

export function lastChart(): FakeChart {
  const chart = charts.at(-1);
  if (chart === undefined) {
    throw new Error('No se ha creado ningun chart');
  }
  return chart;
}

export function lastMarkers(): FakeMarkersPlugin {
  const plugin = markerPlugins.at(-1);
  if (plugin === undefined) {
    throw new Error('No se ha creado ningun plugin de marcadores');
  }
  return plugin;
}

export function seriesOfKind(chart: FakeChart, kind: string): FakeSeries {
  const series = chart.series.find((candidate) => candidate.kind === kind);
  if (series === undefined) {
    throw new Error(`El chart no tiene una serie de tipo ${kind}`);
  }
  return series;
}

function makeSeries(kind: string, paneIndex: number | undefined): FakeSeries {
  const setDataCalls: unknown[][] = [];
  const updateCalls: unknown[] = [];

  return {
    kind,
    paneIndex,
    setDataCalls,
    updateCalls,
    setData(data) {
      setDataCalls.push(data);
    },
    update(point) {
      updateCalls.push(point);
    },
  };
}

function makeTimeScale(): FakeTimeScale {
  const setVisibleLogicalRangeCalls: { from: number; to: number }[] = [];
  const setVisibleRangeCalls: { from: number; to: number }[] = [];
  const rangeListeners: ((range: { from: number; to: number } | null) => void)[] = [];

  return {
    visibleLogicalRange: null,
    setVisibleRangeCalls,
    setVisibleRange(range) {
      setVisibleRangeCalls.push(range);
    },
    setVisibleLogicalRangeCalls,
    rangeListeners,
    getVisibleLogicalRange() {
      return this.visibleLogicalRange;
    },
    setVisibleLogicalRange(range) {
      this.visibleLogicalRange = range;
      setVisibleLogicalRangeCalls.push(range);
    },
    subscribeVisibleLogicalRangeChange(listener) {
      rangeListeners.push(listener);
    },
    unsubscribeVisibleLogicalRangeChange(listener) {
      const index = rangeListeners.indexOf(listener);
      if (index >= 0) {
        rangeListeners.splice(index, 1);
      }
    },
  };
}

export function createChart(container: unknown, options?: unknown): FakeChart {
  const series: FakeSeries[] = [];
  const timeScale = makeTimeScale();

  const chart: FakeChart = {
    container,
    options,
    series,
    removeCalls: 0,
    resizeCalls: [],
    addSeries(definition, _options, paneIndex) {
      const created = makeSeries(definition.kind, paneIndex);
      series.push(created);
      return created;
    },
    timeScale() {
      return timeScale;
    },
    resize(width, height) {
      chart.resizeCalls.push([width, height]);
    },
    remove() {
      chart.removeCalls += 1;
    },
  };

  charts.push(chart);
  return chart;
}

export function createSeriesMarkers(_series: unknown, markers: unknown[]): FakeMarkersPlugin {
  const setMarkersCalls: unknown[][] = [markers];

  const plugin: FakeMarkersPlugin = {
    setMarkersCalls,
    setMarkers(next) {
      setMarkersCalls.push(next);
    },
  };

  markerPlugins.push(plugin);
  return plugin;
}
