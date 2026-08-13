import { z } from 'zod';

const TIMEFRAMES = ['1m', '15m', '1h'] as const;
const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

function splitCsv(raw: string): string[] {
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

const symbolsSchema = z
  .string()
  .transform(splitCsv)
  .pipe(z.array(z.string().regex(/^[A-Z0-9]{5,20}$/, 'simbolo invalido')).min(1))
  .prefault('BTCUSDT');

const timeframesSchema = z
  .string()
  .transform(splitCsv)
  .pipe(z.array(z.enum(TIMEFRAMES)).min(1))
  .prefault('1m,15m,1h');

const intIn = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

export const startModeSchema = z.enum(['api', 'worker', 'ingestor']);

export type StartMode = z.infer<typeof startModeSchema>;

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).prefault('development'),
  START_MODE: startModeSchema.prefault('api'),
  PORT: intIn(1, 65535).prefault('4000'),
  LOG_LEVEL: z.enum(LOG_LEVELS).prefault('info'),

  DATABASE_URL: z
    .string()
    .min(1)
    .regex(/^postgres(ql)?:\/\//, 'debe ser una URL postgres:// o postgresql://'),
  DATABASE_SSL: z.stringbool().prefault('false'),
  REDIS_URL: z
    .string()
    .min(1)
    .regex(/^rediss?:\/\//, 'debe ser una URL redis:// o rediss://'),

  WEB_ORIGIN: z.url().prefault('http://localhost:5173'),

  EXCHANGE: z.literal('bitget').prefault('bitget'),
  EXCHANGE_REST_URL: z.url().prefault('https://api.bitget.com'),
  EXCHANGE_WS_URL: z.url().prefault('wss://ws.bitget.com/v2/ws/public'),

  SYMBOLS: symbolsSchema,
  TIMEFRAMES: timeframesSchema,

  BACKFILL_FROM: z.iso.datetime().prefault('2026-01-01T00:00:00Z'),
  BACKFILL_PAGE_LIMIT: intIn(1, 200).prefault('200'),
  BACKFILL_RPS: z.coerce.number().positive().max(100).prefault('5'),

  WS_RECONNECT_BASE_MS: intIn(100, 60_000).prefault('1000'),
  WS_RECONNECT_MAX_MS: intIn(1_000, 600_000).prefault('30000'),
  WS_STALE_TIMEOUT_MS: intIn(1_000, 600_000).prefault('45000'),
  WS_HEARTBEAT_INTERVAL_MS: intIn(1_000, 600_000).prefault('20000'),
  WS_STABLE_RESET_MS: intIn(1_000, 3_600_000).prefault('60000'),
  WS_MAX_CONSECUTIVE_FAILURES: intIn(1, 1_000).prefault('10'),

  RECONCILE_MAX_PAGES: intIn(1, 500).prefault('10'),

  GAP_SCAN_CRON: z
    .string()
    .regex(/^(\S+\s+){4}\S+$/, 'debe ser una expresion cron de 5 campos')
    .prefault('*/15 * * * *'),
  GAP_SCAN_WINDOW_DAYS: intIn(1, 365).prefault('7'),

  BACKTEST_CONCURRENCY: intIn(1, 32).prefault('2'),
  BACKTEST_MAX_BARS: intIn(1_000, 10_000_000).prefault('500000'),
  ENGINE_CHUNK_BARS: intIn(1_000, 1_000_000).prefault('50000'),
  EQUITY_MAX_POINTS: intIn(100, 100_000).prefault('5000'),

  INGEST_IN_WORKER: z.stringbool().prefault('false'),
});

export type Env = Readonly<z.infer<typeof envSchema>>;

export const ENV_KEYS: readonly string[] = Object.freeze(Object.keys(envSchema.shape));

export class EnvValidationError extends Error {
  override readonly name = 'EnvValidationError';
  readonly missing: readonly string[];
  readonly invalid: readonly string[];

  constructor(message: string, missing: readonly string[], invalid: readonly string[]) {
    super(message);
    this.missing = missing;
    this.invalid = invalid;
  }
}

export type EnvSource = Readonly<Record<string, string | undefined>>;

function buildError(issues: readonly z.core.$ZodIssue[], source: EnvSource): EnvValidationError {
  const missing: string[] = [];
  const invalid: string[] = [];

  for (const issue of issues) {
    const key = typeof issue.path[0] === 'string' ? issue.path[0] : '(raiz)';
    if (source[key] === undefined) {
      missing.push(key);
    } else {
      invalid.push(`${key}: ${issue.message} (valor recibido: ${JSON.stringify(source[key])})`);
    }
  }

  const parts = ['Configuracion de entorno invalida. El proceso no puede arrancar.'];
  if (missing.length > 0) {
    parts.push(
      '',
      `Faltan ${missing.length} variable(s) requerida(s):`,
      ...missing.map((key) => `  - ${key}`),
    );
  }
  if (invalid.length > 0) {
    parts.push(
      '',
      `${invalid.length} variable(s) con valor invalido:`,
      ...invalid.map((detail) => `  - ${detail}`),
    );
  }
  parts.push('', 'Copia .env.example a .env y revisa docs/06-DEPLOY.md §Variables de entorno.');

  return new EnvValidationError(parts.join('\n'), missing, invalid);
}

export function parseEnv(source: EnvSource = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw buildError(result.error.issues, source);
  }
  return Object.freeze(result.data);
}
