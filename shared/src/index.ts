export const SHARED_VERSION = '0.1.0' as const;

export {
  CANDLE_SOURCES,
  candleRowToCandle,
  candleSchema,
  candleSourceSchema,
  type Candle,
  type CandleRow,
  type CandleSource,
} from './candle.js';

export { ERROR_CODES, ERROR_STATUS, isErrorCode, type ErrorCode } from './errors.js';

export {
  BACKTEST_QUEUE_NAME,
  RUN_STATUSES,
  backtestJobSchema,
  runChannel,
  runDoneEventSchema,
  runErrorEventSchema,
  runEventSchema,
  runProgressEventSchema,
  runStatusEventSchema,
  runStatusSchema,
  type BacktestJob,
  type RunEvent,
  type RunProgressEvent,
  type RunStatus,
  type RunStatusEvent,
} from './jobs.js';

export {
  CANDLES_MAX_LIMIT,
  candlesQuerySchema,
  candlesResponseSchema,
  compactCandleSchema,
  coverageGapSchema,
  coverageParamsSchema,
  coverageQuerySchema,
  coverageResponseSchema,
  marketSymbolSchema,
  marketsResponseSchema,
  symbolSchema,
  timestampParamSchema,
  type CandlesQuery,
  type CandlesResponse,
  type CoverageResponse,
  type MarketSymbol,
  type MarketsResponse,
} from './api-schemas.js';

export {
  STRATEGY_PARAM_TYPES,
  strategyCatalogSchema,
  strategyMetaSchema,
  strategyParamSchema,
  type StrategyCatalog,
  type StrategyMeta,
  type StrategyParam,
  type StrategyParamType,
} from './strategy-catalog.js';

export {
  InvalidTimestampError,
  TIMEFRAMES,
  alignTs,
  expectedCandleCount,
  isAligned,
  isTimeframe,
  timeframeSchema,
  timeframeToMs,
  type Timeframe,
} from './timeframe.js';
