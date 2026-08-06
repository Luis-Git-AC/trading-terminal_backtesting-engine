import { parseEnv } from './env.schema.js';

/**
 * Configuracion del proceso actual.
 *
 * Este es el UNICO punto del backend que lee `process.env` (CLAUDE.md §6). El resto del codigo
 * importa `env` o recibe la configuracion por parametro.
 *
 * Se valida al cargar el modulo: si falta una variable requerida o tiene formato invalido, el
 * import lanza `EnvValidationError` y el proceso no arranca. Es deliberado — es preferible morir
 * en el arranque que descubrir a mitad de un backfill que `BACKFILL_RPS` era `"cinco"`.
 */
export const env = parseEnv();

export {
  ENV_KEYS,
  EnvValidationError,
  envSchema,
  parseEnv,
  type Env,
  type EnvSource,
} from './env.schema.js';
