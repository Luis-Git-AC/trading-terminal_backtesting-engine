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
