import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ENV_KEYS, EnvValidationError, parseEnv, type EnvSource } from './env.schema.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_EXAMPLE_PATH = resolve(HERE, '../../../.env.example');

const DATABASE_URL = 'postgres://tt:tt@localhost:5432/trading_terminal';
const REDIS_URL = 'redis://localhost:6379';
const REQUIRED = { DATABASE_URL, REDIS_URL } as const;

function readEnvExample(): { keys: string[]; values: Record<string, string> } {
  const raw = readFileSync(ENV_EXAMPLE_PATH, 'utf8');
  const keys: string[] = [];
  const values: Record<string, string> = {};

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq);
    keys.push(key);
    values[key] = trimmed.slice(eq + 1);
  }

  return { keys, values };
}

function catchEnvError(source: EnvSource): EnvValidationError {
  try {
    parseEnv(source);
  } catch (error) {
    if (error instanceof EnvValidationError) return error;
    throw error;
  }
  return expect.unreachable('parseEnv deberia haber lanzado EnvValidationError');
}

describe('.env.example sincronizado con el esquema', () => {
  const { keys, values } = readEnvExample();
  const backendKeys = keys.filter((key) => !key.startsWith('VITE_'));

  it('no declara la misma clave dos veces', () => {
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('cubre exactamente las claves del esquema Zod', () => {
    expect([...backendKeys].sort()).toEqual([...ENV_KEYS].sort());
  });

  it('documenta la variable del frontend', () => {
    expect(keys).toContain('VITE_API_URL');
  });

  it('es un entorno valido tal cual, sin editar nada', () => {
    expect(() => parseEnv(values)).not.toThrow();
  });
});

describe('parseEnv: variables requeridas', () => {
  it('falla nombrando DATABASE_URL cuando no esta', () => {
    const error = catchEnvError({ REDIS_URL });

    expect(error.missing).toContain('DATABASE_URL');
    expect(error.message).toContain('DATABASE_URL');
    expect(error.message).toContain('Faltan');
  });

  it('lista todas las que faltan de una vez, no solo la primera', () => {
    expect([...catchEnvError({}).missing].sort()).toEqual(['DATABASE_URL', 'REDIS_URL']);
  });

  it('distingue "falta" de "esta mal": protocolo incorrecto es invalida, no ausente', () => {
    const error = catchEnvError({ ...REQUIRED, DATABASE_URL: 'mysql://tt:tt@localhost:3306/tt' });

    expect(error.missing).toEqual([]);
    expect(error.invalid.join('\n')).toContain('DATABASE_URL');
  });
});

describe('parseEnv: defaults', () => {
  it('aplica los defaults documentados en docs/06-DEPLOY.md', () => {
    const env = parseEnv(REQUIRED);

    expect(env.NODE_ENV).toBe('development');
    expect(env.START_MODE).toBe('api');
    expect(env.PORT).toBe(4000);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.DATABASE_SSL).toBe(false);
    expect(env.WEB_ORIGIN).toBe('http://localhost:5173');
    expect(env.EXCHANGE).toBe('bitget');
    expect(env.EXCHANGE_REST_URL).toBe('https://api.bitget.com');
    expect(env.EXCHANGE_WS_URL).toBe('wss://ws.bitget.com/v2/ws/public');
    expect(env.SYMBOLS).toEqual(['BTCUSDT']);
    expect(env.TIMEFRAMES).toEqual(['1m', '15m', '1h']);
    expect(env.BACKFILL_FROM).toBe('2026-01-01T00:00:00Z');
    expect(env.BACKFILL_PAGE_LIMIT).toBe(200);
    expect(env.BACKFILL_RPS).toBe(5);
    expect(env.WS_RECONNECT_BASE_MS).toBe(1000);
    expect(env.WS_RECONNECT_MAX_MS).toBe(30_000);
    expect(env.WS_STALE_TIMEOUT_MS).toBe(45_000);
    expect(env.GAP_SCAN_CRON).toBe('*/15 * * * *');
    expect(env.BACKTEST_CONCURRENCY).toBe(2);
    expect(env.BACKTEST_MAX_BARS).toBe(500_000);
    expect(env.ENGINE_CHUNK_BARS).toBe(50_000);
    expect(env.EQUITY_MAX_POINTS).toBe(5_000);
    expect(env.INGEST_IN_WORKER).toBe(false);
  });

  it('devuelve un objeto congelado', () => {
    expect(Object.isFrozen(parseEnv(REQUIRED))).toBe(true);
  });
});

describe('parseEnv: coercion y rechazo de valores', () => {
  it('convierte numeros que llegan como string', () => {
    const env = parseEnv({ ...REQUIRED, PORT: '8080', BACKFILL_RPS: '2.5' });
    expect(env.PORT).toBe(8080);
    expect(env.BACKFILL_RPS).toBe(2.5);
  });

  it('convierte booleanos que llegan como string', () => {
    expect(parseEnv({ ...REQUIRED, DATABASE_SSL: 'true' }).DATABASE_SSL).toBe(true);
    expect(parseEnv({ ...REQUIRED, INGEST_IN_WORKER: '1' }).INGEST_IN_WORKER).toBe(true);
    expect(parseEnv({ ...REQUIRED, INGEST_IN_WORKER: 'false' }).INGEST_IN_WORKER).toBe(false);
  });

  it('parte los CSV y limpia espacios', () => {
    const env = parseEnv({ ...REQUIRED, SYMBOLS: ' BTCUSDT , ETHUSDT ', TIMEFRAMES: '15m, 1h' });
    expect(env.SYMBOLS).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect(env.TIMEFRAMES).toEqual(['15m', '1h']);
  });

  it('rechaza un timeframe fuera del enum del dominio', () => {
    expect(catchEnvError({ ...REQUIRED, TIMEFRAMES: '1m,4h' }).invalid.join()).toContain(
      'TIMEFRAMES',
    );
  });

  it('rechaza un CSV que se queda vacio al limpiarlo', () => {
    expect(catchEnvError({ ...REQUIRED, SYMBOLS: ' , ' }).invalid.join()).toContain('SYMBOLS');
  });

  it('rechaza PORT fuera de rango y START_MODE desconocido', () => {
    expect(catchEnvError({ ...REQUIRED, PORT: '70000' }).invalid.join()).toContain('PORT');
    expect(catchEnvError({ ...REQUIRED, START_MODE: 'cron' }).invalid.join()).toContain(
      'START_MODE',
    );
  });

  it('rechaza BACKFILL_FROM que no es ISO 8601 UTC', () => {
    expect(catchEnvError({ ...REQUIRED, BACKFILL_FROM: '01/01/2026' }).invalid.join()).toContain(
      'BACKFILL_FROM',
    );
    expect(
      catchEnvError({ ...REQUIRED, BACKFILL_FROM: '2026-01-01 00:00:00' }).invalid.join(),
    ).toContain('BACKFILL_FROM');
  });

  it('rechaza un BACKFILL_PAGE_LIMIT por encima del maximo real de Bitget', () => {
    expect(parseEnv({ ...REQUIRED, BACKFILL_PAGE_LIMIT: '200' }).BACKFILL_PAGE_LIMIT).toBe(200);
    expect(catchEnvError({ ...REQUIRED, BACKFILL_PAGE_LIMIT: '1000' }).invalid.join()).toContain(
      'BACKFILL_PAGE_LIMIT',
    );
  });

  it('rechaza un cron que no tiene cinco campos', () => {
    expect(catchEnvError({ ...REQUIRED, GAP_SCAN_CRON: '*/15 * *' }).invalid.join()).toContain(
      'GAP_SCAN_CRON',
    );
  });
});

describe('modulo env.ts: configuracion del proceso', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('se valida al importar y expone el objeto congelado', async () => {
    vi.stubEnv('DATABASE_URL', DATABASE_URL);
    vi.stubEnv('REDIS_URL', REDIS_URL);
    vi.stubEnv('PORT', '4321');
    vi.resetModules();

    const mod = await import('./env.js');

    expect(mod.env.PORT).toBe(4321);
    expect(Object.isFrozen(mod.env)).toBe(true);
  });

  it('importarlo sin DATABASE_URL aborta el arranque nombrando la variable', async () => {
    vi.stubEnv('DATABASE_URL', undefined);
    vi.stubEnv('REDIS_URL', REDIS_URL);
    vi.resetModules();

    await expect(import('./env.js')).rejects.toThrow(/DATABASE_URL/);
  });
});
