import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createFakeSocketFactory } from '../../../testing/fake-socket.js';
import type { ExchangeStreamEvent, FetchLike, HttpResponse, IngestEvent } from '../adapter.js';
import { UpstreamError } from '../errors.js';
import { createHyperliquidDerivativesClient } from './derivatives.js';
import { dexOf } from './types.js';
import { createHyperliquidCandleStream } from './ws.js';
import {
  buildAssetCtxSubscribeMessage,
  buildAssetCtxUnsubscribeMessage,
  parseHyperliquidWsMessage,
} from './ws-normalize.js';

function loadText(name: string): string {
  const url = new URL(`../../../__fixtures__/hyperliquid/${name}.json`, import.meta.url);
  return readFileSync(url, 'utf8');
}

function loadJson(name: string): unknown {
  return JSON.parse(loadText(name));
}

const FUNDING = loadJson('funding-history-btc');
const FUNDING_UNKNOWN = loadJson('funding-history-unknown');
const META_CTXS = loadJson('meta-and-asset-ctxs-btc');
const WS_ASSET_CTX = loadText('ws-asset-ctx');
const WS_CTX_SUB_RESPONSE = loadText('ws-asset-ctx-subscription-response');

function respond(status: number, body: unknown): HttpResponse {
  return { status, headers: { get: () => null }, json: () => Promise.resolve(body) };
}

function recordFetch(...responses: readonly HttpResponse[]): {
  fetch: FetchLike;
  bodies: string[];
} {
  const bodies: string[] = [];
  let call = 0;

  return {
    bodies,
    fetch: (_url, init) => {
      bodies.push(init?.body ?? '');
      const next = responses[Math.min(call, responses.length - 1)];
      call += 1;
      if (next === undefined) throw new Error('sin respuesta preparada');
      return Promise.resolve(next);
    },
  };
}

describe('funding de Hyperliquid por REST', () => {
  it('devuelve el fixture real con interval_hours = 1', async () => {
    const recorder = recordFetch(respond(200, FUNDING));
    const client = createHyperliquidDerivativesClient({ fetch: recorder.fetch, rps: 1000 });

    const rates = await client.getFundingHistory({ symbol: 'BTC', startTime: 1_792_454_400_000 });

    expect(rates).toHaveLength(6);
    expect(rates[0]).toEqual({ t: 1792454400021, rate: 0.0000125, intervalHours: 1 });
    expect(rates.every((rate) => rate.intervalHours === 1)).toBe(true);

    const body = JSON.parse(recorder.bodies[0] ?? '{}');
    expect(body).toEqual({ type: 'fundingHistory', coin: 'BTC', startTime: 1_792_454_400_000 });
  });

  it('las marcas de tiempo distan una hora, como el periodo que se guarda', async () => {
    const client = createHyperliquidDerivativesClient({
      fetch: recordFetch(respond(200, FUNDING)).fetch,
      rps: 1000,
    });

    const rates = await client.getFundingHistory({ symbol: 'BTC', startTime: 0 });
    const steps = rates.slice(1).map((rate, index) => rate.t - (rates[index]?.t ?? 0));

    expect(steps.every((step) => Math.abs(step - 3_600_000) < 1000)).toBe(true);
  });

  it('un coin inexistente devuelve null y eso es un UpstreamError, no una lista vacia', async () => {
    const client = createHyperliquidDerivativesClient({
      fetch: recordFetch(respond(200, FUNDING_UNKNOWN)).fetch,
      rps: 1000,
    });

    await expect(client.getFundingHistory({ symbol: 'NOPE' })).rejects.toBeInstanceOf(
      UpstreamError,
    );
  });

  it('manda endTime solo cuando se pide', async () => {
    const recorder = recordFetch(respond(200, FUNDING));
    const client = createHyperliquidDerivativesClient({ fetch: recorder.fetch, rps: 1000 });

    await client.getFundingHistory({ symbol: 'BTC', startTime: 10, endTime: 20 });

    expect(JSON.parse(recorder.bodies[0] ?? '{}')).toEqual({
      type: 'fundingHistory',
      coin: 'BTC',
      startTime: 10,
      endTime: 20,
    });
  });
});

describe('open interest de Hyperliquid por REST', () => {
  it('lo saca de metaAndAssetCtxs cruzando universe con los ctx', async () => {
    const recorder = recordFetch(respond(200, META_CTXS));
    const client = createHyperliquidDerivativesClient({ fetch: recorder.fetch, rps: 1000 });

    const point = await client.getOpenInterest('BTC');

    expect(point.base).toBe(43446.6771);
    expect(point.quote).toBeNull();
    expect(point.t).toBeGreaterThan(0);
    expect(JSON.parse(recorder.bodies[0] ?? '{}')).toEqual({ type: 'metaAndAssetCtxs' });
  });

  it('un mercado HIP-3 pide el ctx de su dex', async () => {
    const recorder = recordFetch(respond(200, META_CTXS));
    const client = createHyperliquidDerivativesClient({ fetch: recorder.fetch, rps: 1000 });

    await client.getOpenInterest('BTC').catch(() => undefined);
    recorder.bodies.length = 0;
    await client.getOpenInterest('xyz:GOLD').catch(() => undefined);

    expect(JSON.parse(recorder.bodies[0] ?? '{}')).toEqual({
      type: 'metaAndAssetCtxs',
      dex: 'xyz',
    });
    expect(dexOf('xyz:GOLD')).toBe('xyz');
    expect(dexOf('BTC')).toBeUndefined();
  });

  it('un coin que el universo no lista revienta en vez de inventarse un cero', async () => {
    const client = createHyperliquidDerivativesClient({
      fetch: recordFetch(respond(200, META_CTXS)).fetch,
      rps: 1000,
    });

    await expect(client.getOpenInterest('ETH')).rejects.toBeInstanceOf(UpstreamError);
  });

  it('no hay OI historico: devuelve lista vacia y lo dice por el log', async () => {
    const events: IngestEvent[] = [];
    const client = createHyperliquidDerivativesClient({
      fetch: recordFetch(respond(200, META_CTXS)).fetch,
      rps: 1000,
      log: (event) => events.push(event),
    });

    expect(await client.getOpenInterestHistory({ symbol: 'BTC' })).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('truncated');
  });
});

describe('activeAssetCtx por el socket de velas', () => {
  it('suscribe y desuscribe con la forma del contrato', () => {
    expect(JSON.parse(buildAssetCtxSubscribeMessage('BTC'))).toEqual({
      method: 'subscribe',
      subscription: { type: 'activeAssetCtx', coin: 'BTC' },
    });
    expect(JSON.parse(buildAssetCtxUnsubscribeMessage('xyz:GOLD'))).toEqual({
      method: 'unsubscribe',
      subscription: { type: 'activeAssetCtx', coin: 'xyz:GOLD' },
    });
  });

  it('distingue la confirmacion del ctx de la de velas', () => {
    expect(parseHyperliquidWsMessage(WS_CTX_SUB_RESPONSE)).toEqual({
      kind: 'subscribed-ctx',
      symbol: 'BTC',
    });
    expect(parseHyperliquidWsMessage(WS_ASSET_CTX)).toEqual({
      kind: 'asset-ctx',
      symbol: 'BTC',
      funding: 0.0000125,
      openInterest: 43446.54996,
    });
  });

  it('un ctx con numeros rotos no se emite como dato bueno', () => {
    const broken = JSON.stringify({
      channel: 'activeAssetCtx',
      data: { coin: 'BTC', ctx: { funding: 'nope', openInterest: '1' } },
    });

    expect(parseHyperliquidWsMessage(broken).kind).toBe('unparsable');
  });

  it('la suscripcion al ctx NO abre un segundo socket', () => {
    const fakes = createFakeSocketFactory();
    const events: ExchangeStreamEvent[] = [];
    const stream = createHyperliquidCandleStream({
      url: 'ws://local.test',
      createSocket: fakes.factory,
      staleTimeoutMs: 0,
      heartbeatIntervalMs: 0,
    });
    stream.on((event) => events.push(event));

    stream.subscribe('BTC', '1m');
    stream.connect();
    fakes.last().emitOpen();
    stream.subscribeAssetCtx?.('BTC');
    stream.subscribeAssetCtx?.('ETH');

    expect(fakes.created).toHaveLength(1);

    const sent = fakes.last().sent.map((raw) => JSON.parse(raw) as unknown);
    expect(sent).toContainEqual({
      method: 'subscribe',
      subscription: { type: 'candle', coin: 'BTC', interval: '1m' },
    });
    expect(sent).toContainEqual({
      method: 'subscribe',
      subscription: { type: 'activeAssetCtx', coin: 'BTC' },
    });
    expect(sent).toContainEqual({
      method: 'subscribe',
      subscription: { type: 'activeAssetCtx', coin: 'ETH' },
    });

    fakes.last().emitMessage(WS_CTX_SUB_RESPONSE);
    fakes.last().emitMessage(WS_ASSET_CTX);

    expect(events).toContainEqual({ kind: 'subscribedCtx', symbol: 'BTC' });
    expect(events).toContainEqual({
      kind: 'assetCtx',
      symbol: 'BTC',
      funding: 0.0000125,
      openInterest: 43446.54996,
    });
    expect(fakes.created).toHaveLength(1);
  });
});
