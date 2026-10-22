import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { timeframeToMs } from '@tt/shared';
import { UpstreamError } from '../errors.js';
import {
  createHyperliquidRestClient,
  splitRange,
  type FetchLike,
  type HttpResponse,
  type IngestEvent,
} from './rest.js';
import {
  HYPERLIQUID_DEFAULT_BASE_URL,
  HYPERLIQUID_INFO_PATH,
  HYPERLIQUID_MAX_HISTORY_CANDLES,
} from './types.js';

function loadFixture(name: string): unknown {
  const url = new URL(`../../../__fixtures__/hyperliquid/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8'));
}

const OK_FIXTURE = loadFixture('candle-snapshot-15m-ok');
const EMPTY_FIXTURE = loadFixture('candle-snapshot-empty');
const DIRTY_FIXTURE = loadFixture('candle-snapshot-15m-dirty');
const UNKNOWN_COIN_FIXTURE = loadFixture('unknown-coin');

const STEP = timeframeToMs('15m');
const FIRST_TS = 1_792_665_000_000;

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
  calls: { url: string; body: unknown }[];
}

function recordFetch(...responses: readonly (HttpResponse | Error)[]): Recorder {
  const calls: { url: string; body: unknown }[] = [];
  let call = 0;

  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, body: init?.body === undefined ? undefined : JSON.parse(init.body) });
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

describe('splitRange', () => {
  it('un rango que cabe en una llamada es un solo tramo', () => {
    expect(splitRange(0, 10 * STEP, STEP)).toEqual([{ startTime: 0, endTime: 10 * STEP }]);
  });

  it('un rango de mas de 5000 velas se parte de lo mas reciente a lo mas antiguo', () => {
    const span = HYPERLIQUID_MAX_HISTORY_CANDLES * STEP;
    const chunks = splitRange(0, 2 * span + STEP, STEP);

    expect(chunks).toHaveLength(3);
    expect(chunks[0]?.endTime).toBe(2 * span + STEP);
    expect(chunks[0]?.startTime).toBe(span + STEP);
    expect(chunks.at(-1)?.startTime).toBe(0);
    for (const chunk of chunks) {
      expect((chunk.endTime - chunk.startTime) / STEP).toBeLessThanOrEqual(
        HYPERLIQUID_MAX_HISTORY_CANDLES,
      );
    }
  });
});

describe('createHyperliquidRestClient: peticion', () => {
  it('pide candleSnapshot por POST, sin API key ni firma', async () => {
    const recorder = recordFetch(respond(200, OK_FIXTURE));
    const client = createHyperliquidRestClient({ fetch: recorder.fetch });

    await client.getHistoryCandles({
      symbol: 'BTC',
      timeframe: '15m',
      startTime: FIRST_TS,
      endTime: FIRST_TS + 6 * STEP,
    });

    const [call] = recorder.calls;
    expect(call?.url).toBe(`${HYPERLIQUID_DEFAULT_BASE_URL}${HYPERLIQUID_INFO_PATH}`);
    expect(call?.body).toEqual({
      type: 'candleSnapshot',
      req: { coin: 'BTC', interval: '15m', startTime: FIRST_TS, endTime: FIRST_TS + 6 * STEP },
    });
  });
});

describe('createHyperliquidRestClient: velas', () => {
  it('el snapshot del fixture normaliza a velas alineadas y ordenadas', async () => {
    const recorder = recordFetch(respond(200, OK_FIXTURE));
    const client = createHyperliquidRestClient({ fetch: recorder.fetch });

    const candles = await client.getHistoryCandles({
      symbol: 'BTC',
      timeframe: '15m',
      startTime: FIRST_TS,
      endTime: FIRST_TS + 6 * STEP,
    });

    expect(candles).toHaveLength(6);
    expect(candles[0]?.t).toBe(FIRST_TS);
    expect(candles.every((candle) => candle.t % STEP === 0)).toBe(true);
    expect(candles.map((candle) => candle.t)).toEqual([...candles].sort((a, b) => a.t - b.t).map((c) => c.t));
  });

  it('las filas corruptas se descartan con su razon y no abortan el snapshot', async () => {
    const events: IngestEvent[] = [];
    const recorder = recordFetch(respond(200, DIRTY_FIXTURE));
    const client = createHyperliquidRestClient({
      fetch: recorder.fetch,
      log: (event) => events.push(event),
    });

    const candles = await client.getHistoryCandles({
      symbol: 'BTC',
      timeframe: '15m',
      startTime: FIRST_TS,
      endTime: FIRST_TS + 7 * STEP,
    });

    expect(candles.map((candle) => candle.t)).toEqual([FIRST_TS, FIRST_TS + 6 * STEP]);
    const discarded = events.find((event) => event.kind === 'discarded');
    expect(discarded?.kind === 'discarded' ? discarded.rows.map((row) => row.reason) : []).toEqual([
      'malformed',
      'invalid-candle',
      'unaligned',
      'not-numeric',
      'invalid-candle',
    ]);
  });

  it('un rango de mas de 5000 velas se parte en varias llamadas', async () => {
    const recorder = recordFetch(respond(200, OK_FIXTURE));
    const client = createHyperliquidRestClient({ fetch: recorder.fetch });
    const endTime = FIRST_TS + 12_000 * STEP;

    await client.getHistoryCandles({
      symbol: 'BTC',
      timeframe: '15m',
      startTime: FIRST_TS,
      endTime,
      limit: HYPERLIQUID_MAX_HISTORY_CANDLES,
    });

    expect(recorder.calls).toHaveLength(3);
  });

  it('un tramo vacio avisa de que ese historico no existe y corta', async () => {
    const events: IngestEvent[] = [];
    const recorder = recordFetch(respond(200, OK_FIXTURE), respond(200, EMPTY_FIXTURE));
    const client = createHyperliquidRestClient({
      fetch: recorder.fetch,
      log: (event) => events.push(event),
    });

    const candles = await client.getHistoryCandles({
      symbol: 'BTC',
      timeframe: '15m',
      startTime: FIRST_TS,
      endTime: FIRST_TS + 12_000 * STEP,
    });

    expect(recorder.calls).toHaveLength(2);
    expect(candles).toHaveLength(6);
    const truncated = events.find((event) => event.kind === 'truncated');
    expect(truncated?.kind === 'truncated' ? truncated.detail : '').toContain(
      String(HYPERLIQUID_MAX_HISTORY_CANDLES),
    );
  });
});

describe('createHyperliquidRestClient: errores', () => {
  it('un coin que no existe devuelve null y se explica, no se confunde con vacio', async () => {
    const recorder = recordFetch(respond(200, UNKNOWN_COIN_FIXTURE));
    const client = createHyperliquidRestClient({ fetch: recorder.fetch });

    const error = asUpstream(
      await client
        .getHistoryCandles({ symbol: 'NOPE', timeframe: '15m', startTime: FIRST_TS, endTime: FIRST_TS + STEP })
        .catch((e: unknown) => e),
    );

    expect(error.message).toContain('NOPE');
  });

  it('un 422 con cuerpo de texto plano aborta sin reintentar', async () => {
    const recorder = recordFetch({
      status: 422,
      headers: { get: () => null },
      json: () => Promise.reject(new Error('no es JSON')),
    });
    const client = createHyperliquidRestClient({ fetch: recorder.fetch });

    const error = asUpstream(
      await client
        .getHistoryCandles({ symbol: 'BTC', timeframe: '15m', startTime: FIRST_TS, endTime: FIRST_TS + STEP })
        .catch((e: unknown) => e),
    );

    expect(error.status).toBe(422);
    expect(error.retryable).toBe(false);
    expect(recorder.calls).toHaveLength(1);
  });
});

describe('createHyperliquidRestClient: reintentos', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('un 429 con Retry-After espera lo pedido y reintenta', async () => {
    const events: IngestEvent[] = [];
    const recorder = recordFetch(
      respond(429, {}, { 'retry-after': '2' }),
      respond(200, OK_FIXTURE),
    );
    const client = createHyperliquidRestClient({
      fetch: recorder.fetch,
      log: (event) => events.push(event),
    });

    const pending = client
      .getHistoryCandles({ symbol: 'BTC', timeframe: '15m', startTime: FIRST_TS, endTime: FIRST_TS + 6 * STEP })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(120_000);
    const candles = await pending;

    expect(Array.isArray(candles) ? candles : []).toHaveLength(6);
    expect(recorder.calls).toHaveLength(2);
    expect(events).toEqual([{ kind: 'retry', attempt: 1, delayMs: 2000, reason: 'HTTP 429' }]);
  });
});
