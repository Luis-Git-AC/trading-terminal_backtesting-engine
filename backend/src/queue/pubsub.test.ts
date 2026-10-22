import { describe, expect, it } from 'vitest';
import type { Candle } from '@tt/shared';
import { candleChannel, createCandlePublisher } from './pubsub.js';

const CANDLE: Candle = { t: 1_700_000_000_000, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 };

describe('candleChannel', () => {
  it('el exchange forma parte del canal', () => {
    expect(candleChannel('binance', 'BTCUSDT', '1m')).not.toBe(
      candleChannel('hyperliquid', 'BTCUSDT', '1m'),
    );
  });
});

describe('createCandlePublisher', () => {
  it('un publish que revienta se reporta y no propaga', async () => {
    const errors: Error[] = [];
    const publisher = createCandlePublisher({
      redis: {
        publish: () => Promise.reject(new Error('sin conexion')),
        quit: () => Promise.resolve('OK'),
      },
      onError: (error) => errors.push(error),
    });

    await publisher.publishCandle('binance', 'BTCUSDT', '1m', CANDLE, true);

    expect(errors.map((error) => error.message)).toEqual(['sin conexion']);
  });

  it('cerrar un cliente ya cerrado se reporta pero no corta el apagado', async () => {
    const errors: Error[] = [];
    const publisher = createCandlePublisher({
      redis: {
        publish: () => Promise.resolve(1),
        quit: () => Promise.reject(new Error('Connection is closed.')),
      },
      onError: (error) => errors.push(error),
    });

    await expect(publisher.close()).resolves.toBeUndefined();
    expect(errors.map((error) => error.message)).toEqual(['Connection is closed.']);
  });
});
