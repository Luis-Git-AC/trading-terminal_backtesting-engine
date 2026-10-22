import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { UpstreamError } from '../errors.js';
import type { FetchLike, HttpResponse, IngestEvent } from '../adapter.js';
import { OI_HIST_WINDOW_MS, createBinanceDerivativesClient } from './derivatives.js';
import {
  BINANCE_FUNDING_INFO_PATH,
  BINANCE_FUNDING_PATH,
  BINANCE_OI_HIST_PATH,
  BINANCE_OI_PATH,
} from './types.js';

const FUNDING_FIXTURE = loadFixture('funding-rate-xauusdt');
const FUNDING_INFO_FIXTURE = loadFixture('funding-info');
const OI_HIST_FIXTURE = loadFixture('open-interest-hist-xauusdt-1h');
const OI_FIXTURE = loadFixture('open-interest-xauusdt');
const UNKNOWN_SYMBOL_FIXTURE = loadFixture('error-unknown-symbol');
const OI_TOO_OLD_FIXTURE = loadFixture('error-oi-hist-too-old');

function loadFixture(name: string): unknown {
  const url = new URL(`../../../__fixtures__/binance/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8'));
}

function respond(status: number, body: unknown): HttpResponse {
  return {
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  };
}

/** Responde segun el path pedido, como hace el exchange: el orden de las llamadas no se fija. */
function routed(routes: Readonly<Record<string, HttpResponse>>): { fetch: FetchLike; urls: string[] } {
  const urls: string[] = [];

  return {
    urls,
    fetch: (url: string) => {
      urls.push(url);
      const path = new URL(url).pathname;
      const response = routes[path];
      if (response === undefined) throw new Error(`sin respuesta preparada para ${path}`);
      return Promise.resolve(response);
    },
  };
}

const ALL_OK: Readonly<Record<string, HttpResponse>> = {
  [BINANCE_FUNDING_INFO_PATH]: respond(200, FUNDING_INFO_FIXTURE),
  [BINANCE_FUNDING_PATH]: respond(200, FUNDING_FIXTURE),
  [BINANCE_OI_HIST_PATH]: respond(200, OI_HIST_FIXTURE),
  [BINANCE_OI_PATH]: respond(200, OI_FIXTURE),
};

describe('funding de Binance', () => {
  it('devuelve las tasas del fixture con el periodo real del simbolo', async () => {
    const recorder = routed(ALL_OK);
    const client = createBinanceDerivativesClient({ fetch: recorder.fetch, rps: 1000 });

    const rates = await client.getFundingHistory({ symbol: 'XAUUSDT' });

    expect(rates).toHaveLength(12);
    expect(rates[0]).toEqual({ t: 1790812800002, rate: 0.00001938, intervalHours: 4 });
    expect(rates.every((rate) => rate.intervalHours === 4)).toBe(true);
    expect(rates.map((rate) => rate.t)).toEqual([...rates].sort((a, b) => a.t - b.t).map((r) => r.t));
  });

  it('un simbolo que fundingInfo no lista se guarda con las 8 h por defecto', async () => {
    const client = createBinanceDerivativesClient({ fetch: routed(ALL_OK).fetch, rps: 1000 });

    expect(await client.fundingIntervalHours('ETHUSDT')).toBe(8);
    expect(await client.fundingIntervalHours('CLUSDT')).toBe(4);
  });

  it('pide fundingInfo una sola vez aunque se recojan varios simbolos', async () => {
    const recorder = routed(ALL_OK);
    const client = createBinanceDerivativesClient({ fetch: recorder.fetch, rps: 1000 });

    await client.getFundingHistory({ symbol: 'XAUUSDT' });
    await client.getFundingHistory({ symbol: 'XAGUSDT' });

    const infoCalls = recorder.urls.filter((url) => url.includes(BINANCE_FUNDING_INFO_PATH));
    expect(infoCalls).toHaveLength(1);
  });

  it('manda el rango y el limite en la URL', async () => {
    const recorder = routed(ALL_OK);
    const client = createBinanceDerivativesClient({ fetch: recorder.fetch, rps: 1000 });

    await client.getFundingHistory({
      symbol: 'XAUUSDT',
      startTime: 1_790_812_800_000,
      endTime: 1_790_899_200_000,
      limit: 99,
    });

    const url = new URL(recorder.urls[recorder.urls.length - 1] ?? '');
    expect(url.pathname).toBe(BINANCE_FUNDING_PATH);
    expect(url.searchParams.get('symbol')).toBe('XAUUSDT');
    expect(url.searchParams.get('startTime')).toBe('1790812800000');
    expect(url.searchParams.get('endTime')).toBe('1790899200000');
    expect(url.searchParams.get('limit')).toBe('99');
  });

  it('un limite absurdo se recorta al maximo del endpoint', async () => {
    const recorder = routed(ALL_OK);
    const client = createBinanceDerivativesClient({ fetch: recorder.fetch, rps: 1000 });

    await client.getFundingHistory({ symbol: 'XAUUSDT', limit: Number.POSITIVE_INFINITY });

    const url = new URL(recorder.urls[recorder.urls.length - 1] ?? '');
    expect(url.searchParams.get('limit')).toBe('1000');
  });

  it('un simbolo inexistente devuelve lista vacia, no un error', async () => {
    const client = createBinanceDerivativesClient({
      fetch: routed({ ...ALL_OK, [BINANCE_FUNDING_PATH]: respond(200, UNKNOWN_SYMBOL_FIXTURE) })
        .fetch,
      rps: 1000,
    });

    expect(await client.getFundingHistory({ symbol: 'NOPEUSDT' })).toEqual([]);
  });

  it('un cuerpo que no cumple el contrato revienta con UpstreamError', async () => {
    const client = createBinanceDerivativesClient({
      fetch: routed({ ...ALL_OK, [BINANCE_FUNDING_PATH]: respond(200, { nope: true }) }).fetch,
      rps: 1000,
    });

    await expect(client.getFundingHistory({ symbol: 'XAUUSDT' })).rejects.toBeInstanceOf(
      UpstreamError,
    );
  });
});

describe('open interest de Binance', () => {
  it('el historico llega con el ts del exchange, en base y en quote', async () => {
    const client = createBinanceDerivativesClient({ fetch: routed(ALL_OK).fetch, rps: 1000 });

    const points = await client.getOpenInterestHistory({ symbol: 'XAUUSDT' });

    expect(points).toHaveLength(6);
    expect(points[0]).toEqual({
      t: 1792681200000,
      base: 209537.787,
      quote: 852267128.8877027,
    });
  });

  it('el OI actual usa el time del exchange, no el de recepcion', async () => {
    const client = createBinanceDerivativesClient({ fetch: routed(ALL_OK).fetch, rps: 1000 });

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    try {
      const point = await client.getOpenInterest('XAUUSDT');
      expect(point).toEqual({ t: 1792699532471, base: 202083.404, quote: null });
      expect(point.t).not.toBe(Date.now());
    } finally {
      vi.useRealTimers();
    }
  });

  it('un startTime mas viejo que la ventana de 30 dias se recorta y se avisa', async () => {
    const events: IngestEvent[] = [];
    const recorder = routed(ALL_OK);
    const client = createBinanceDerivativesClient({
      fetch: recorder.fetch,
      rps: 1000,
      log: (event) => events.push(event),
    });

    const now = Date.now();
    await client.getOpenInterestHistory({ symbol: 'XAUUSDT', startTime: now - 90 * 86_400_000 });

    const url = new URL(recorder.urls[recorder.urls.length - 1] ?? '');
    const sent = Number(url.searchParams.get('startTime'));
    expect(sent).toBeGreaterThanOrEqual(now - OI_HIST_WINDOW_MS);
    expect(url.searchParams.get('period')).toBe('1h');
    expect(events.filter((event) => event.kind === 'truncated')).toHaveLength(1);
  });

  it('un startTime dentro de la ventana se manda tal cual y sin aviso', async () => {
    const events: IngestEvent[] = [];
    const recorder = routed(ALL_OK);
    const client = createBinanceDerivativesClient({
      fetch: recorder.fetch,
      rps: 1000,
      log: (event) => events.push(event),
    });

    const startTime = Date.now() - 2 * 86_400_000;
    await client.getOpenInterestHistory({ symbol: 'XAUUSDT', startTime, period: '4h' });

    const url = new URL(recorder.urls[recorder.urls.length - 1] ?? '');
    expect(url.searchParams.get('startTime')).toBe(String(startTime));
    expect(url.searchParams.get('period')).toBe('4h');
    expect(events).toEqual([]);
  });

  it('el 400 de un rango fuera de ventana no se reintenta y explica el motivo', async () => {
    const client = createBinanceDerivativesClient({
      fetch: routed({ ...ALL_OK, [BINANCE_OI_HIST_PATH]: respond(400, OI_TOO_OLD_FIXTURE) }).fetch,
      rps: 1000,
    });

    await expect(
      client.getOpenInterestHistory({ symbol: 'XAUUSDT' }),
    ).rejects.toThrow(/-1130/);
  });
});
