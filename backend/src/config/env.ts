import { parseEnv } from './env.schema.js';

export const env = parseEnv();

export {
  allSymbols,
  defaultExchange,
  exchangeConfig,
  exchangeConfigs,
  LEGACY_ENV_KEYS,
  ENV_KEYS,
  EnvValidationError,
  envSchema,
  parseEnv,
  type Env,
  type EnvSource,
  type ExchangeConfig,
} from './env.schema.js';
