import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseEnv } from '../../../config/env.schema.js';
import { UpstreamError } from '../errors.js';
import {
  createBitgetRestClient,
  type FetchLike,
  type HttpResponse,
  type IngestEvent,
} from './rest.js';
import {
  BITGET_DEFAULT_BASE_URL,
  BITGET_HISTORY_CANDLES_PATH,
  BITGET_MAX_PAGE_LIMIT,
} from './types.js';

const OK_FIXTURE = loadFixture('history-candles-15m-ok');
const EMPTY_FIXTURE = loadFixture('history-candles-empty');
const DIRTY_FIXTURE = loadFixture('history-candles-15m-dirty');
const LIMIT_ERROR_FIXTURE = loadFixture('error-limit-out-of-range');
const GRANULARITY_ERROR_FIXTURE = loadFixture('error-bad-granularity');

function loadFixture(name: string): unknown {
  const url = new URL(`../../../__fixtures__/bitget/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8'));
}

function respond(
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): HttpResponse {
  return {
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: () => Promise.resolve(body),
  };
}

interface Recorder {
  fetch: FetchLike;
  urls: string[];
}

function recordFetch(...responses: readonly (HttpResponse | Error)[]): Recorder {
  const urls: string[] = [];
  let call = 0;

  return {
    urls,
    fetch: (url: string) => {
      urls.push(url);
      const next = responses[Math.min(call, responses.length - 1)];
      call += 1;
      if (next instanceof Error) return Promise.reject(next);
      if (next === undefined) throw new Error('sin respuesta preparada para esta llamada');
      return Promise.resolve(next);
    },
  };
}

function paramsOf(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

function asUpstream(value: unknown): UpstreamError {
  if (value instanceof UpstreamError) return value;
  return expect.unreachable(`se esperaba un UpstreamError, llego: ${String(value)}`);
}

describe('createBitgetRestClient: construccion de la peticion', () => {
  it('apunta al endpoint publico de velas historicas con los parametros del contrato', async () => {
    const recorder = recordFetch(respond(200, OK_FIXTURE));
    const client = createBitgetRestClient({ fetch: recorder.fetch });

    await client.getHistoryCandles({ symbol: 'BTCUSDT', timeframe: '15m' });

    const [requested] = recorder.urls;
    expect(requested).toBeDefined();
    const url = new URL(requested ?? '');
    expect(url.origin).toBe(BITGET_DEFAULT_BASE_URL);
    expect(url.pathname).toBe(BITGET_HISTORY_CANDLES_PATH);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      symbol: 'BTCUSDT',
      productType: 'USDT-FUTURES',
      granularity: '15m',
      limit: '200',
    });
  });

  it('traduce el timeframe del dominio a la granularity de Bitget respetando mayusculas', async () => {
    const recorder = recordFetch(respond(200, EMPTY_FIXTURE));
    const client = createBitgetRestClient({ fetch: recorder.fetch });

    await client.getHistoryCandles({ symbol: 'BTCUSDT', timeframe: '1m' });
    await client.getHistoryCandles({ symbol: 'BTCUSDT', timeframe: '15m' });
    await client.getHistoryCandles({ symbol: 'BTCUSDT', timeframe: '1h' });

    expect(recorder.urls.map((url) => paramsOf(url).get('granularity'))).toEqual([
      '1m',
      '15m',
      '1H',
    ]);
  });

  it('manda startTime y endTime solo cuando se piden', async () => {
    const recorder = recordFetch(respond(200, EMPTY_FIXTURE));
    const client = createBitgetRestClient({ fetch: recorder.fetch });

    await client.getHistoryCandles({ symbol: 'BTCUSDT', timeframe: '1h', endTime: 1767225600000 });

    const params = paramsOf(recorder.urls[0] ?? '');
    expect(params.get('endTime')).toBe('1767225600000');
    expect(params.has('startTime')).toBe(false);
  });

  it('usa el baseUrl inyectado, que es lo que permite testear sin salir a la red', async () => {
    const recorder = recordFetch(respond(200, EMPTY_FIXTURE));
    const client = createBitgetRestClient({
      fetch: recorder.fetch,
      baseUrl: 'http://127.0.0.1:9999',
    });

    await client.getHistoryCandles({ symbol: 'BTCUSDT', timeframe: '1h' });

    expect(recorder.urls[0]).toContain(`http://127.0.0.1:9999${BITGET_HISTORY_CANDLES_PATH}`);
  });
});

describe('createBitgetRestClient: limite de pagina real del exchange', () => {
  it('rechaza al construir un pageLimit por encima del maximo de Bitget', () => {
    expect(() => createBitgetRestClient({ pageLimit: 1000 })).toThrow(RangeError);
    expect(() => createBitgetRestClient({ pageLimit: 201 })).toThrow(/200/);
    expect(() => createBitgetRestClient({ pageLimit: 0 })).toThrow(RangeError);
  });

  it('rechaza tambien el limit puntual de una consulta', async () => {
    const client = createBitgetRestClient({ fetch: recordFetch(respond(200, OK_FIXTURE)).fetch });

    await expect(
      client.getHistoryCandles({ symbol: 'BTCUSDT', timeframe: '15m', limit: 1000 }),
    ).rejects.toThrow(RangeError);
  });

  it('el default de BACKFILL_PAGE_LIMIT no supera el maximo real del exchange', () => {
    const env = parseEnv({
      DATABASE_URL: 'postgres://tt:tt@localhost:5432/trading_terminal',
      REDIS_URL: 'redis://localhost:6379',
    });

    expect(BITGET_MAX_PAGE_LIMIT).toBe(200);
    expect(env.BACKFILL_PAGE_LIMIT).toBeLessThanOrEqual(BITGET_MAX_PAGE_LIMIT);
  });
});

describe('createBitgetRestClient: respuestas correctas', () => {
  it('convierte el fixture real en velas ordenadas', async () => {
    const client = createBitgetRestClient({ fetch: recordFetch(respond(200, OK_FIXTURE)).fetch });

    const candles = await client.getHistoryCandles({ symbol: 'BTCUSDT', timeframe: '15m' });

    expect(candles).toEqual([
      { t: 1767225600000, o: 87624.4, h: 87796.4, l: 87607, c: 87720.2, v: 292.2548 },
      { t: 1767226500000, o: 87720.2, h: 87769.8, l: 87720.2, c: 87760.8, v: 60.0385 },
      { t: 1767227400000, o: 87760.8, h: 87761.5, l: 87707.6, c: 87730.5, v: 59.1333 },
      { t: 1767228300000, o: 87730.5, h: 87834.6, l: 87730.5, c: 87790, v: 70.5034 },
      { t: 1767229200000, o: 87790, h: 88003.4, l: 87790, c: 87981.1, v: 349.0742 },
    ]);
  });

  it('un rango sin datos devuelve un array vacio, no un error', async () => {
    const client = createBitgetRestClient({ fetch: recordFetch(respond(200, EMPTY_FIXTURE)).fetch });

    await expect(
      client.getHistoryCandles({ symbol: 'BTCUSDT', timeframe: '15m', endTime: 1420074900000 }),
    ).resolves.toEqual([]);
  });

  it('descarta las velas invalidas, las registra y no tira el proceso', async () => {
    const events: IngestEvent[] = [];
    const client = createBitgetRestClient({
      fetch: recordFetch(respond(200, DIRTY_FIXTURE)).fetch,
      log: (event) => events.push(event),
    });

    const candles = await client.getHistoryCandles({ symbol: 'BTCUSDT', timeframe: '15m' });

    expect(candles.map((candle) => candle.t)).toEqual([1767225600000, 1767231000000]);

    const [discarded] = events;
    expect(discarded?.kind).toBe('discarded');
    if (discarded?.kind !== 'discarded') expect.unreachable('se esperaba un evento discarded');
    expect(discarded.symbol).toBe('BTCUSDT');
    expect(discarded.timeframe).toBe('15m');
    expect(discarded.rows.map((row) => row.reason)).toEqual([
      'malformed',
      'invalid-candle',
      'unaligned',
      'not-numeric',
      'invalid-candle',
    ]);
  });
});

describe('createBitgetRestClient: errores de negocio con HTTP 200', () => {
  it('trata code distinto de 00000 como fallo aunque el status sea 200', async () => {
    const recorder = recordFetch(respond(200, LIMIT_ERROR_FIXTURE));
    const client = createBitgetRestClient({ fetch: recorder.fetch });

    const error: unknown = await client
      .getHistoryCandles({ symbol: 'BTCUSDT', timeframe: '15m' })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ exchangeCode: '40053', code: 'UPSTREAM_UNAVAILABLE' });
    expect(asUpstream(error).message).toContain('limit should be between 1~200');
    expect(recorder.urls).toHaveLength(1);
  });

  it('no reintenta un error de parametros: no se arregla repitiendo', async () => {
    const recorder = recordFetch(respond(200, GRANULARITY_ERROR_FIXTURE));
    const client = createBitgetRestClient({ fetch: recorder.fetch });

    await expect(
      client.getHistoryCandles({ symbol: 'BTCUSDT', timeframe: '1h' }),
    ).rejects.toBeInstanceOf(UpstreamError);
    expect(recorder.urls).toHaveLength(1);
  });

  it('avisa de que el contrato ha cambiado si el cuerpo no tiene la forma esperada', async () => {
    const recorder = recordFetch(respond(200, { velas: [] }));
    const client = createBitgetRestClient({ fetch: recorder.fetch });

    await expect(
      client.getHistoryCandles({ symbol: 'BTCUSDT', timeframe: '15m' }),
    ).rejects.toThrow(/contrato ha cambiado/);
    expect(recorder.urls).toHaveLength(1);
  });

  it('avisa igual si data deja de ser un array', async () => {
    const recorder = recordFetch(respond(200, { code: '00000', msg: 'success', data: {} }));
    const client = createBitgetRestClient({ fetch: recorder.fetch });

    await expect(
      client.getHistoryCandles({ symbol: 'BTCUSDT', timeframe: '15m' }),
    ).rejects.toThrow(/contrato ha cambiado/);
  });
});

describe('createBitgetRestClient: reintentos', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function settle(promise: Promise<unknown>): Promise<unknown> {
    const result = promise.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(120_000);
    return result;
  }

  it('un 429 con Retry-After espera lo que dice la cabecera y reintenta', async () => {
    const events: IngestEvent[] = [];
    const recorder = recordFetch(
      respond(429, { code: '429', msg: 'too many requests', data: null }, { 'retry-after': '2' }),
      respond(200, OK_FIXTURE),
    );
    const client = createBitgetRestClient({ fetch: recorder.fetch, log: (e) => events.push(e) });

    const candles = await settle(
      client.getHistoryCandles({ symbol: 'BTCUSDT', timeframe: '15m' }),
    );

    expect(Array.isArray(candles)).toBe(true);
    expect(recorder.urls).toHaveLength(2);
    expect(events).toEqual([
      { kind: 'retry', attempt: 1, delayMs: 2000, reason: 'HTTP 429' },
    ]);
  });

  it('sin Retry-After usa backoff exponencial con jitter acotado por el intento', async () => {
    const events: IngestEvent[] = [];
    const recorder = recordFetch(respond(503, { code: '503', msg: 'unavailable', data: null }));
    const client = createBitgetRestClient({
      fetch: recorder.fetch,
      random: () => 1,
      log: (event) => events.push(event),
    });

    await settle(client.getHistoryCandles({ symbol: 'BTCUSDT', timeframe: '15m' }));

    expect(events.map((event) => (event.kind === 'retry' ? event.delayMs : -1))).toEqual([
      500, 1000, 2000, 4000,
    ]);
  });

  it('el jitter mantiene la espera dentro de [0, techo] del intento', async () => {
    const events: IngestEvent[] = [];
    const recorder = recordFetch(respond(500, { code: '500', msg: 'boom', data: null }));
    const client = createBitgetRestClient({
      fetch: recorder.fetch,
      random: () => 0.25,
      log: (event) => events.push(event),
    });

    await settle(client.getHistoryCandles({ symbol: 'BTCUSDT', timeframe: '15m' }));

    expect(events.map((event) => (event.kind === 'retry' ? event.delayMs : -1))).toEqual([
      125, 250, 500, 1000,
    ]);
  });

  it('agotar los reintentos lanza UpstreamError con el numero de intentos', async () => {
    const recorder = recordFetch(respond(503, { code: '503', msg: 'unavailable', data: null }));
    const client = createBitgetRestClient({ fetch: recorder.fetch, random: () => 0 });

    const error = await settle(client.getHistoryCandles({ symbol: 'BTCUSDT', timeframe: '15m' }));

    expect(error).toBeInstanceOf(UpstreamError);
    expect(error).toMatchObject({ attempts: 5, status: 503, retryable: true });
    expect(recorder.urls).toHaveLength(5);
  });

  it('reintenta tambien los errores de red y acaba en UpstreamError', async () => {
    const recorder = recordFetch(new Error('ECONNRESET'));
    const client = createBitgetRestClient({
      fetch: recorder.fetch,
      random: () => 0,
      maxAttempts: 3,
    });

    const error = await settle(client.getHistoryCandles({ symbol: 'BTCUSDT', timeframe: '15m' }));

    expect(asUpstream(error).message).toContain('ECONNRESET');
    expect(recorder.urls).toHaveLength(3);
  });

  it('se recupera si el fallo es transitorio', async () => {
    const recorder = recordFetch(
      new Error('ETIMEDOUT'),
      respond(500, { code: '500', msg: 'boom', data: null }),
      respond(200, OK_FIXTURE),
    );
    const client = createBitgetRestClient({ fetch: recorder.fetch, random: () => 0 });

    const candles = await settle(client.getHistoryCandles({ symbol: 'BTCUSDT', timeframe: '15m' }));

    expect(candles).toHaveLength(5);
    expect(recorder.urls).toHaveLength(3);
  });

  it('un 4xx que no es 429 no se reintenta', async () => {
    const recorder = recordFetch(respond(404, { code: '40404', msg: 'not found', data: null }));
    const client = createBitgetRestClient({ fetch: recorder.fetch });

    const error = await settle(client.getHistoryCandles({ symbol: 'BTCUSDT', timeframe: '15m' }));

    expect(error).toBeInstanceOf(UpstreamError);
    expect(error).toMatchObject({ status: 404, attempts: 1, retryable: false });
    expect(recorder.urls).toHaveLength(1);
  });

  it('ignora un Retry-After absurdo y cae al backoff', async () => {
    const events: IngestEvent[] = [];
    const recorder = recordFetch(
      respond(429, { code: '429', msg: 'slow down', data: null }, { 'retry-after': '86400' }),
      respond(200, OK_FIXTURE),
    );
    const client = createBitgetRestClient({
      fetch: recorder.fetch,
      random: () => 1,
      log: (event) => events.push(event),
    });

    await settle(client.getHistoryCandles({ symbol: 'BTCUSDT', timeframe: '15m' }));

    expect(events).toEqual([{ kind: 'retry', attempt: 1, delayMs: 500, reason: 'HTTP 429' }]);
  });
});

describe('createBitgetRestClient: limite de salida', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('no supera BACKFILL_RPS al pedir varias paginas seguidas', async () => {
    const recorder = recordFetch(respond(200, EMPTY_FIXTURE));
    const client = createBitgetRestClient({ fetch: recorder.fetch, rps: 5 });
    const start = Date.now();
    const at: number[] = [];

    const pages = Array.from({ length: 4 }, () =>
      client
        .getHistoryCandles({ symbol: 'BTCUSDT', timeframe: '1m' })
        .then(() => at.push(Date.now() - start)),
    );

    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all(pages);

    expect(at).toEqual([0, 200, 400, 600]);
    expect(client.limiter.intervalMs).toBe(200);
  });
});
