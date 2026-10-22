import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UpstreamError } from '../errors.js';
import {
  WEIGHT_PAUSE_RATIO,
  createBinanceRestClient,
  weightPauseMs,
  type FetchLike,
  type HttpResponse,
  type IngestEvent,
} from './rest.js';
import {
  BINANCE_DEFAULT_BASE_URL,
  BINANCE_KLINES_PATH,
  BINANCE_MAX_PAGE_LIMIT,
  BINANCE_WEIGHT_PER_MINUTE,
} from './types.js';

const OK_FIXTURE = loadFixture('klines-15m-ok');
const EMPTY_FIXTURE = loadFixture('klines-empty');
const DIRTY_FIXTURE = loadFixture('klines-15m-dirty');
const INTERVAL_ERROR_FIXTURE = loadFixture('error-bad-interval');

function loadFixture(name: string): unknown {
  const url = new URL(`../../../__fixtures__/binance/${name}.json`, import.meta.url);
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

function asUpstream(value: unknown): UpstreamError {
  if (value instanceof UpstreamError) return value;
  return expect.unreachable(`se esperaba un UpstreamError, llego: ${String(value)}`);
}

describe('createBinanceRestClient: construccion de la peticion', () => {
  it('apunta al endpoint publico de klines con los parametros del contrato', async () => {
    const recorder = recordFetch(respond(200, OK_FIXTURE));
    const client = createBinanceRestClient({ fetch: recorder.fetch });

    await client.getHistoryCandles({
      symbol: 'BTCUSDT',
      timeframe: '15m',
      startTime: 1_767_225_600_000,
      endTime: 1_767_230_100_000,
    });

    const [requested] = recorder.urls;
    expect(requested).toBeDefined();
    const url = new URL(requested ?? '');
    expect(url.origin).toBe(BINANCE_DEFAULT_BASE_URL);
    expect(url.pathname).toBe(BINANCE_KLINES_PATH);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      symbol: 'BTCUSDT',
      interval: '15m',
      limit: String(BINANCE_MAX_PAGE_LIMIT),
      startTime: '1767225600000',
      endTime: '1767230100000',
    });
  });

  it('rechaza un limit fuera del maximo real de Binance sin tocar la red', async () => {
    const recorder = recordFetch(respond(200, OK_FIXTURE));
    const client = createBinanceRestClient({ fetch: recorder.fetch });

    await expect(
      client.getHistoryCandles({ symbol: 'BTCUSDT', timeframe: '15m', limit: 1501 }),
    ).rejects.toThrow(RangeError);
    expect(recorder.urls).toEqual([]);
  });
});

describe('createBinanceRestClient: velas', () => {
  it('el rango del fixture devuelve velas alineadas, ordenadas y sin huecos', async () => {
    const recorder = recordFetch(respond(200, OK_FIXTURE));
    const client = createBinanceRestClient({ fetch: recorder.fetch });

    const candles = await client.getHistoryCandles({ symbol: 'BTCUSDT', timeframe: '15m' });

    expect(candles).toHaveLength(5);
    expect(candles[0]?.t).toBe(1_767_225_600_000);
    const steps = candles.slice(1).map((candle, index) => candle.t - (candles[index]?.t ?? 0));
    expect(steps).toEqual([900_000, 900_000, 900_000, 900_000]);
    expect(candles.every((candle) => candle.t % 900_000 === 0)).toBe(true);
  });

  it('rellena el quote volume, que Binance si da', async () => {
    const recorder = recordFetch(respond(200, OK_FIXTURE));
    const client = createBinanceRestClient({ fetch: recorder.fetch });

    const candles = await client.getHistoryCandles({ symbol: 'BTCUSDT', timeframe: '15m' });

    expect(candles[0]?.q).toBeCloseTo(65_994_654.3096, 3);
  });

  it('un rango sin historico devuelve una pagina vacia, no un error', async () => {
    const recorder = recordFetch(respond(200, EMPTY_FIXTURE));
    const client = createBinanceRestClient({ fetch: recorder.fetch });

    await expect(client.getHistoryCandles({ symbol: 'BTCUSDT', timeframe: '15m' })).resolves.toEqual(
      [],
    );
  });

  it('las filas corruptas se descartan con su razon y no abortan la pagina', async () => {
    const events: IngestEvent[] = [];
    const recorder = recordFetch(respond(200, DIRTY_FIXTURE));
    const client = createBinanceRestClient({
      fetch: recorder.fetch,
      log: (event) => events.push(event),
    });

    const candles = await client.getHistoryCandles({ symbol: 'BTCUSDT', timeframe: '15m' });

    expect(candles.map((candle) => candle.t)).toEqual([1_767_225_600_000, 1_767_231_000_000]);

    const discarded = events.find((event) => event.kind === 'discarded');
    expect(discarded?.kind).toBe('discarded');
    expect(discarded?.kind === 'discarded' ? discarded.rows.map((row) => row.reason) : []).toEqual([
      'malformed',
      'invalid-candle',
      'unaligned',
      'not-numeric',
      'invalid-candle',
    ]);
  });
});

describe('createBinanceRestClient: errores y reintentos', () => {
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

  it('un 429 con Retry-After espera lo pedido y reintenta', async () => {
    const events: IngestEvent[] = [];
    const recorder = recordFetch(respond(429, {}, { 'retry-after': '2' }), respond(200, OK_FIXTURE));
    const client = createBinanceRestClient({
      fetch: recorder.fetch,
      log: (event) => events.push(event),
    });

    const candles = await settle(client.getHistoryCandles({ symbol: 'BTCUSDT', timeframe: '15m' }));

    expect(Array.isArray(candles) ? candles : []).toHaveLength(5);
    expect(recorder.urls).toHaveLength(2);
    expect(events).toEqual([{ kind: 'retry', attempt: 1, delayMs: 2000, reason: 'HTTP 429' }]);
  });

  it('un 418 aborta con UpstreamError sin reintentar: la IP ya esta baneada', async () => {
    const recorder = recordFetch(respond(418, {}));
    const client = createBinanceRestClient({ fetch: recorder.fetch });

    const error = asUpstream(
      await client.getHistoryCandles({ symbol: 'BTCUSDT', timeframe: '15m' }).catch((e: unknown) => e),
    );

    expect(error.status).toBe(418);
    expect(error.retryable).toBe(false);
    expect(recorder.urls).toHaveLength(1);
  });

  it('un error de negocio con HTTP 400 nombra el codigo de Binance', async () => {
    const recorder = recordFetch(respond(400, INTERVAL_ERROR_FIXTURE));
    const client = createBinanceRestClient({ fetch: recorder.fetch });

    const error = asUpstream(
      await client.getHistoryCandles({ symbol: 'BTCUSDT', timeframe: '15m' }).catch((e: unknown) => e),
    );

    expect(error.status).toBe(400);
    expect(error.message).toContain('-1120');
    expect(recorder.urls).toHaveLength(1);
  });
});

describe('weightPauseMs', () => {
  it('sin cabecera de peso no frena', () => {
    expect(weightPauseMs({ get: () => null }, 0)).toBe(0);
  });

  it('por debajo del umbral no frena', () => {
    const used = String(Math.floor(BINANCE_WEIGHT_PER_MINUTE * WEIGHT_PAUSE_RATIO) - 1);
    expect(weightPauseMs({ get: () => used }, 0)).toBe(0);
  });

  it('al rozar el tope frena lo que queda de la ventana del minuto', () => {
    const used = String(BINANCE_WEIGHT_PER_MINUTE);
    expect(weightPauseMs({ get: () => used }, 1_767_225_620_000)).toBe(40_000);
  });
});
