import {
  candlesResponseSchema,
  coverageResponseSchema,
  createBacktestResponseSchema,
  equityResponseSchema,
  eventsResponseSchema,
  fundingResponseSchema,
  healthResponseSchema,
  listBacktestsResponseSchema,
  macroSeriesResponseSchema,
  marketsResponseSchema,
  openInterestResponseSchema,
  runDetailSchema,
  strategyCatalogSchema,
  tradesResponseSchema,
  type CandlesResponse,
  type CoverageResponse,
  type CreateBacktestResponse,
  type EquityResponse,
  type EventsResponse,
  type FundingResponse,
  type HealthResponse,
  type ListBacktestsResponse,
  type MacroSeriesResponse,
  type MarketsResponse,
  type OpenInterestResponse,
  type RunDetail,
  type StrategyCatalog,
  type TradesResponse,
} from '@tt/shared';

export const RUN_ID = '11111111-2222-4333-8444-555555555555';
export const OTHER_RUN_ID = '99999999-8888-4777-8666-555555555555';

function frozen<T>(schema: { parse: (value: unknown) => T }, value: T): T {
  return schema.parse(value);
}

export const health: HealthResponse = frozen(healthResponseSchema, {
  status: 'ok',
  uptimeSec: 1234,
  version: '0.1.0',
  checks: { db: 'ok', redis: 'ok', ingest: { status: 'ok', lastCandleAgeSec: 12 } },
});

export const markets: MarketsResponse = frozen(marketsResponseSchema, {
  exchanges: [
    {
      exchange: 'binance',
      symbols: [
        { symbol: 'BTCUSDT', timeframes: ['1m', '15m', '1h'], pricePrecision: 1, qtyPrecision: 4 },
        { symbol: 'ETHUSDT', timeframes: ['1m', '15m', '1h'], pricePrecision: 2, qtyPrecision: 3 },
      ],
    },
    {
      exchange: 'hyperliquid',
      symbols: [
        { symbol: 'BTC', timeframes: ['1m', '15m', '1h'], pricePrecision: 1, qtyPrecision: 4 },
      ],
    },
  ],
});

export const coverage: CoverageResponse = frozen(coverageResponseSchema, {
  exchange: 'binance',
  symbol: 'BTCUSDT',
  timeframe: '15m',
  from: '2026-01-01T00:00:00.000Z',
  to: '2026-08-01T00:00:00.000Z',
  candles: 20_352,
  expected: 20_353,
  missing: 1,
  gaps: [{ from: '2026-03-02T04:15:00.000Z', to: '2026-03-02T04:15:00.000Z', filled: false }],
  backfill: { done: true, cursor: null },
});

export const candles: CandlesResponse = frozen(candlesResponseSchema, {
  exchange: 'binance',
  symbol: 'BTCUSDT',
  timeframe: '15m',
  count: 3,
  candles: [
    { t: 1_785_000_000_000, o: 64_010.5, h: 64_080, l: 63_990.1, c: 64_055.2, v: 12.4 },
    { t: 1_785_000_900_000, o: 64_055.2, h: 64_120.7, l: 64_001.3, c: 64_100.9, v: 9.8 },
    { t: 1_785_001_800_000, o: 64_100.9, h: 64_150.2, l: 64_050.4, c: 64_075.6, v: 11.1 },
  ],
  nextFrom: 1_785_002_700_000,
});

export const funding: FundingResponse = frozen(fundingResponseSchema, {
  exchange: 'binance',
  symbol: 'BTCUSDT',
  count: 2,
  funding: [
    { t: 1_785_000_000_000, rate: 0.0001, intervalHours: 8 },
    { t: 1_785_028_800_000, rate: -0.00005, intervalHours: 8 },
  ],
  nextFrom: null,
});

export const openInterest: OpenInterestResponse = frozen(openInterestResponseSchema, {
  exchange: 'binance',
  symbol: 'BTCUSDT',
  count: 2,
  openInterest: [
    { t: 1_785_000_000_000, base: 81_234.5, quote: 5_203_000_000 },
    { t: 1_785_003_600_000, base: 81_990.1, quote: null },
  ],
  nextFrom: null,
});

export const strategies: StrategyCatalog = frozen(strategyCatalogSchema, {
  strategies: [
    {
      id: 'ema-cross',
      name: 'EMA Cross',
      version: '1.0.0',
      description: 'Cruce de EMA rapida sobre lenta con stop por ATR',
      params: [
        { key: 'fastPeriod', type: 'int', default: 12, min: 2, max: 200, label: 'EMA rapida' },
        { key: 'slowPeriod', type: 'int', default: 26, min: 3, max: 400, label: 'EMA lenta' },
        { key: 'allowShort', type: 'bool', default: true },
      ],
    },
  ],
});

const metrics = {
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

export const run: RunDetail = frozen(runDetailSchema, {
  id: RUN_ID,
  status: 'completed',
  exchange: 'binance',
  symbol: 'BTCUSDT',
  timeframe: '15m',
  strategyId: 'ema-cross',
  label: 'ema 12/26 H1 2026',
  seed: 42,
  engineVersion: '1.0.0',
  paramsHash: '9ab3cafe',
  range: { from: '2026-01-01T00:00:00.000Z', to: '2026-06-30T23:59:59.000Z' },
  progress: { barsDone: 17_472, barsTotal: 17_472 },
  metrics,
  error: null,
  timings: {
    createdAt: '2026-08-01T10:00:00.000Z',
    startedAt: '2026-08-01T10:00:01.000Z',
    finishedAt: '2026-08-01T10:00:05.000Z',
    durationMs: 4210,
  },
  params: { fastPeriod: 12, slowPeriod: 26, allowShort: true },
  exec: {
    initialCapital: 10_000,
    riskPerTradePct: 1,
    feeBps: 6,
    slippageBps: 2,
    fillModel: 'next-open',
  },
});

const { params: _params, exec: _exec, ...runSummary } = run;

export const runs: ListBacktestsResponse = frozen(listBacktestsResponseSchema, {
  runs: [runSummary, { ...runSummary, id: OTHER_RUN_ID, status: 'running', metrics: null }],
});

export const trades: TradesResponse = frozen(tradesResponseSchema, {
  trades: [
    {
      seq: 1,
      side: 'long',
      entryTs: 1_785_000_000_000,
      entryPrice: '64010.5000000000',
      exitTs: 1_785_001_800_000,
      exitPrice: '64100.9000000000',
      qty: '0.1500000000',
      fees: '1.9200000000',
      pnlQuote: '11.6400000000',
      pnlR: 0.58,
      exitReason: 'take-profit',
      maeR: -0.21,
      mfeR: 0.74,
    },
  ],
  nextCursor: null,
});

export const equity: EquityResponse = frozen(equityResponseSchema, {
  points: [
    { t: 1_785_000_000_000, equity: '10000.0000000000', dd: 0 },
    { t: 1_785_001_800_000, equity: '10011.6400000000', dd: 0 },
  ],
});

export const created: CreateBacktestResponse = frozen(createBacktestResponseSchema, {
  runId: RUN_ID,
  status: 'queued',
  seed: 42,
  paramsHash: '9ab3cafe',
  barsTotal: 17_472,
  warnings: [],
});

export const macroSeries: MacroSeriesResponse = frozen(macroSeriesResponseSchema, {
  source: 'fred',
  seriesId: 'DFII10',
  count: 3,
  points: [
    { t: 1_784_000_000_000, value: 1.8, publishedAt: 1_784_086_400_000, fetchedAt: 1_784_086_400_000, revision: 0 },
    { t: 1_784_086_400_000, value: 1.82, publishedAt: 1_784_172_800_000, fetchedAt: 1_784_172_800_000, revision: 0 },
    { t: 1_784_172_800_000, value: 1.76, publishedAt: 1_784_259_200_000, fetchedAt: 1_784_259_200_000, revision: 0 },
  ],
  asOf: null,
  nextFrom: null,
});

export const marketEvents: EventsResponse = frozen(eventsResponseSchema, {
  count: 2,
  events: [
    {
      id: '42',
      source: 'cftc',
      type: 'cftc-cot',
      assetTags: ['gold', 'silver', 'oil'],
      scheduledAt: 1_785_000_000_000,
      publishedAt: 1_785_259_800_000,
      fetchedAt: 1_785_262_380_000,
      payload: { report: 'legacy-futures-only', reportDate: '2026-07-21' },
    },
    {
      id: '41',
      source: 'eia',
      type: 'eia-wpsr',
      assetTags: ['oil'],
      scheduledAt: 1_784_900_000_000,
      publishedAt: 1_784_900_000_000,
      fetchedAt: 1_784_900_000_000,
      payload: { report: 'weekly-petroleum-status', period: '2026-07-17' },
    },
  ],
  asOf: null,
  nextTo: null,
});
