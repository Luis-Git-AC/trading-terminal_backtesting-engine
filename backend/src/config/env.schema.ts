import { z } from 'zod';
import {
  DEFAULT_EXCHANGE,
  EXCHANGES as KNOWN_EXCHANGES,
  SYMBOL_PATTERN,
  type Exchange,
} from '@tt/shared';

const TIMEFRAMES = ['1m', '15m', '1h'] as const;
const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

function splitCsv(raw: string): string[] {
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function symbolsSchema(fallback: string) {
  return z
    .string()
    .transform(splitCsv)
    .pipe(
      z
        .array(
          z
            .string()
            .transform((value) => value.toUpperCase())
            .refine((value) => SYMBOL_PATTERN.test(value), 'simbolo invalido'),
        )
        .min(1),
    )
    .prefault(fallback);
}

const exchangesSchema = z
  .string()
  .transform(splitCsv)
  .pipe(z.array(z.enum(KNOWN_EXCHANGES)).min(1))
  .prefault(DEFAULT_EXCHANGE);

/**
 * Claves de entorno por exchange. Anadir un exchange al registry anade su fila aqui.
 */
const EXCHANGE_ENV_KEYS = {
  binance: {
    restUrl: 'BINANCE_REST_URL',
    wsUrl: 'BINANCE_WS_URL',
    symbols: 'BINANCE_SYMBOLS',
  },
  hyperliquid: {
    restUrl: 'HYPERLIQUID_REST_URL',
    wsUrl: 'HYPERLIQUID_WS_URL',
    symbols: 'HYPERLIQUID_SYMBOLS',
  },
} as const satisfies Record<Exchange, { restUrl: string; wsUrl: string; symbols: string }>;

/**
 * Claves de la version de un solo exchange. Si siguen en el .env el arranque aborta:
 * ignorarlas en silencio dejaria el stack apuntando a un exchange que ya no es el configurado.
 */
export const LEGACY_ENV_KEYS = [
  'EXCHANGE',
  'EXCHANGE_REST_URL',
  'EXCHANGE_WS_URL',
  'SYMBOLS',
] as const;

const timeframesSchema = z
  .string()
  .transform(splitCsv)
  .pipe(z.array(z.enum(TIMEFRAMES)).min(1))
  .prefault('1m,15m,1h');

const intIn = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

const cronSchema = (fallback: string) =>
  z
    .string()
    .regex(/^(\S+\s+){4}\S+$/, 'debe ser una expresion cron de 5 campos')
    .prefault(fallback);

/** Ids de serie de una fuente macro: letras, digitos, guion y guion bajo. */
const seriesSchema = (fallback: string) =>
  z
    .string()
    .transform(splitCsv)
    .pipe(
      z
        .array(
          z
            .string()
            .transform((value) => value.toUpperCase())
            .refine((value) => /^[A-Z0-9_-]{1,64}$/.test(value), 'id de serie invalido'),
        )
        .min(1),
    )
    .prefault(fallback);

/** Clave opcional: vacia cuenta como ausente, que es lo que desactiva la fuente que la necesita. */
const optionalSecret = () =>
  z.preprocess(
    (value) => (typeof value === 'string' && value.length === 0 ? undefined : value),
    z.string().min(1).optional(),
  );

export const startModeSchema = z.enum(['api', 'worker', 'ingestor', 'collector', 'brain', 'mcp']);

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

  EXCHANGES: exchangesSchema,

  BINANCE_REST_URL: z.url().prefault('https://fapi.binance.com'),
  BINANCE_WS_URL: z.url().prefault('wss://fstream.binance.com/stream'),
  BINANCE_SYMBOLS: symbolsSchema('BTCUSDT'),

  HYPERLIQUID_REST_URL: z.url().prefault('https://api.hyperliquid.xyz'),
  HYPERLIQUID_WS_URL: z.url().prefault('wss://api.hyperliquid.xyz/ws'),
  HYPERLIQUID_SYMBOLS: symbolsSchema('BTC'),

  TIMEFRAMES: timeframesSchema,

  BACKFILL_FROM: z.iso.datetime().prefault('2026-01-01T00:00:00Z'),
  // 1500 es el maximo de /fapi/v1/klines; cada adapter recorta con su maxPageLimit.
  BACKFILL_PAGE_LIMIT: intIn(1, 1500).prefault('200'),
  BACKFILL_RPS: z.coerce.number().positive().max(100).prefault('5'),

  WS_RECONNECT_BASE_MS: intIn(100, 60_000).prefault('1000'),
  WS_RECONNECT_MAX_MS: intIn(1_000, 600_000).prefault('30000'),
  WS_STALE_TIMEOUT_MS: intIn(1_000, 600_000).prefault('45000'),
  WS_HEARTBEAT_INTERVAL_MS: intIn(1_000, 600_000).prefault('20000'),
  WS_STABLE_RESET_MS: intIn(1_000, 3_600_000).prefault('60000'),
  WS_MAX_CONSECUTIVE_FAILURES: intIn(1, 1_000).prefault('10'),

  RECONCILE_MAX_PAGES: intIn(1, 500).prefault('10'),

  GAP_SCAN_CRON: cronSchema('*/15 * * * *'),
  GAP_SCAN_WINDOW_DAYS: intIn(1, 365).prefault('7'),

  DERIVATIVES_CRON: cronSchema('7 * * * *'),
  COLLECTOR_SOURCE_RPS: z.coerce.number().positive().max(100).prefault('2'),
  COLLECTOR_CONCURRENCY: intIn(1, 32).prefault('1'),
  // Sin la clave de una fuente, esa fuente se omite con un aviso: el proceso no muere.
  FRED_API_KEY: optionalSecret(),
  EIA_API_KEY: optionalSecret(),
  FRED_BASE_URL: z.url().prefault('https://api.stlouisfed.org'),
  FRED_SERIES: seriesSchema('DFII10,DTWEXBGS,DFF'),
  FRED_CRON: cronSchema('23 6 * * *'),
  // Las revisiones del FRED aterrizan sobre fechas de observacion viejas, asi que cada pasada
  // pide la serie entera desde aqui: una ventana incremental se dejaria la correccion fuera.
  FRED_OBSERVATION_START: z.iso.date().prefault('2015-01-01'),
  EIA_BASE_URL: z.url().prefault('https://api.eia.gov'),
  // Inventarios semanales: crudo sin la reserva estrategica, gasolina y destilados.
  EIA_SERIES: seriesSchema('WCESTUS1,WGTSTUS1,WDISTUS1'),
  // Diario, no semanal: el informe sale el miercoles a las 10:30 de Nueva York, pero la EIA
  // corrige semanas ya publicadas y una pasada semanal se dejaria la correccion fuera.
  EIA_CRON: cronSchema('41 15 * * *'),
  EIA_START: z.iso.date().prefault('2015-01-01'),
  // La CFTC es gratis y sin clave, asi que la fuente no tiene `requiredEnv`.
  CFTC_URL: z.url().prefault('https://www.cftc.gov/dea/newcot/deafut.txt'),
  // El informe sale el viernes a las 15:30 de Nueva York; diario para no depender de la hora.
  CFTC_CRON: cronSchema('13 20 * * *'),
  DEFILLAMA_TVL_URL: z.url().prefault('https://api.llama.fi'),
  DEFILLAMA_STABLECOINS_URL: z.url().prefault('https://stablecoins.llama.fi'),
  DEFILLAMA_CRON: cronSchema('17 5 * * *'),
  // La serie de TVL arranca en 2017 y sus primeros anos son ceros.
  DEFILLAMA_FROM: z.iso.date().prefault('2020-01-01'),
  COINGECKO_BASE_URL: z.url().prefault('https://api.coingecko.com'),
  // Tier gratuito: limite de peticiones bajo, asi que una vez al dia y nada mas.
  COINGECKO_CRON: cronSchema('31 5 * * *'),
  COINGECKO_RPS: z.coerce.number().positive().max(10).prefault('0.2'),
  // Noticias: la lista de feeds es un fichero versionado (`sources/rss/feeds.ts`), aqui solo
  // va la frecuencia, que el ticket fija entre 5 y 15 minutos.
  RSS_CRON: cronSchema('*/10 * * * *'),
  // Cerebro: el modelo se cachea en HF_HOME (volumen en el compose), asi que cambiarlo implica
  // una descarga. La dimension vive en el tipo de la columna: cambiar de modelo es una migracion.
  BRAIN_MODEL: z.string().min(1).prefault('Xenova/all-MiniLM-L6-v2'),
  // El modelo come CPU y compite con el worker de backtests.
  BRAIN_CONCURRENCY: intIn(1, 16).prefault('1'),
  BRAIN_SCAN_CRON: cronSchema('*/5 * * * *'),
  BRAIN_SCAN_LIMIT: intIn(1, 500).prefault('50'),
  // El etiquetado es determinista y barato, asi que va mas seguido y con mas documentos por pasada
  // que el barrido de embeddings.
  BRAIN_TAG_CRON: cronSchema('*/2 * * * *'),
  BRAIN_TAG_LIMIT: intIn(1, 500).prefault('200'),
  // Sin ruta, el export a Obsidian se desactiva con un aviso y el resto de `brain` sigue igual.
  // Obsidian es una vista, no almacenamiento (ADR-006): el vault se puede borrar y reconstruir.
  OBSIDIAN_VAULT_PATH: z.string().optional(),
  OBSIDIAN_EXPORT_CRON: cronSchema('*/15 * * * *'),
  // openInterestHist solo guarda 30 dias; pedir mas atras es un 400.
  DERIVATIVES_LOOKBACK_DAYS: intIn(1, 30).prefault('7'),

  BACKTEST_CONCURRENCY: intIn(1, 32).prefault('2'),
  BACKTEST_MAX_ACTIVE_RUNS: intIn(1, 10_000).prefault('25'),
  RATE_LIMIT_WINDOW_MS: intIn(1_000, 3_600_000).prefault('60000'),
  RATE_LIMIT_MAX_BACKTESTS: intIn(1, 10_000).prefault('60'),
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

export interface ExchangeConfig {
  readonly exchange: Exchange;
  readonly restUrl: string;
  readonly wsUrl: string;
  readonly symbols: readonly string[];
}

export function exchangeConfig(env: Env, exchange: Exchange): ExchangeConfig {
  const keys = EXCHANGE_ENV_KEYS[exchange];
  return {
    exchange,
    restUrl: env[keys.restUrl],
    wsUrl: env[keys.wsUrl],
    symbols: env[keys.symbols],
  };
}

export function exchangeConfigs(env: Env): readonly ExchangeConfig[] {
  return env.EXCHANGES.map((exchange) => exchangeConfig(env, exchange));
}

export function defaultExchange(env: Env): Exchange {
  return env.EXCHANGES[0] ?? DEFAULT_EXCHANGE;
}

export function allSymbols(env: Env): readonly string[] {
  return [...new Set(exchangeConfigs(env).flatMap((config) => config.symbols))];
}

function legacyKeysIn(source: EnvSource): readonly string[] {
  return LEGACY_ENV_KEYS.filter((key) => source[key] !== undefined);
}

export function parseEnv(source: EnvSource = process.env): Env {
  const legacy = legacyKeysIn(source);
  if (legacy.length > 0) {
    throw new EnvValidationError(
      [
        'Configuracion de entorno de la version de un solo exchange. El proceso no puede arrancar.',
        '',
        `${legacy.length} clave(s) retirada(s) en la fase 7:`,
        ...legacy.map((key) => `  - ${key}`),
        '',
        'Usa EXCHANGES y las claves por exchange (<EXCHANGE>_REST_URL, <EXCHANGE>_WS_URL,',
        '<EXCHANGE>_SYMBOLS). Copia .env.example a .env y revisa docs/06-DEPLOY.md.',
      ].join('\n'),
      [],
      legacy.map((key) => `${key}: clave retirada en la fase 7`),
    );
  }

  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw buildError(result.error.issues, source);
  }
  return Object.freeze(result.data);
}
