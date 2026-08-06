import { parseEnv } from './env.schema.js';

export const env = parseEnv();

export {
  ENV_KEYS,
  EnvValidationError,
  envSchema,
  parseEnv,
  type Env,
  type EnvSource,
} from './env.schema.js';
