import { describe, expect, it } from 'vitest';
import type { Candle } from '@tt/shared';
import {
  changePct,
  nextLivePrice,
  referenceClose,
  type LivePriceUpdate,
} from '@/state/live-price';

const HOUR = 3_600_000;

function candle(t: number, c: number): Candle {
  return { t, o: c, h: c, l: c, c, v: 1 };
}

function hourly(count: number): Candle[] {
  return Array.from({ length: count }, (_, i) => candle(i * HOUR, 100 + i));
}

function update(symbol: string, price: number): LivePriceUpdate {
  return { symbol, candle: candle(0, price), referencePrice: null };
}

describe('referenceClose', () => {
  it('toma el cierre de la ultima vela que queda a 24 h o mas de la mas reciente', () => {
    expect(referenceClose(hourly(30))).toBe(105);
  });

  it('si la ventana no cubre 24 h no inventa una referencia', () => {
    expect(referenceClose(hourly(10))).toBeNull();
  });

  it('sin velas no hay referencia', () => {
    expect(referenceClose([])).toBeNull();
  });
});

describe('changePct', () => {
  it('calcula la variacion porcentual sobre la referencia', () => {
    expect(changePct(110, 100)).toBeCloseTo(10, 10);
    expect(changePct(95, 100)).toBeCloseTo(-5, 10);
  });

  it('sin referencia, o con referencia cero, no hay variacion', () => {
    expect(changePct(110, null)).toBeNull();
    expect(changePct(110, 0)).toBeNull();
  });
});

describe('nextLivePrice', () => {
  it('el primer precio no tiene direccion', () => {
    expect(nextLivePrice(null, update('BTCUSDT', 100))).toMatchObject({
      price: 100,
      direction: 'flat',
      seq: 1,
    });
  });

  it('marca subida y bajada respecto al precio anterior del mismo simbolo', () => {
    const first = nextLivePrice(null, update('BTCUSDT', 100));
    const up = nextLivePrice(first, update('BTCUSDT', 101));
    const down = nextLivePrice(up, update('BTCUSDT', 99));

    expect(up?.direction).toBe('up');
    expect(down?.direction).toBe('down');
    expect(down?.seq).toBe(3);
  });

  it('cambiar de simbolo no se lee como subida ni bajada', () => {
    const btc = nextLivePrice(null, update('BTCUSDT', 66_000));

    expect(nextLivePrice(btc, update('ETHUSDT', 3_000))?.direction).toBe('flat');
  });

  it('retirar el precio lo deja vacio', () => {
    expect(nextLivePrice(nextLivePrice(null, update('BTCUSDT', 100)), null)).toBeNull();
  });
});
