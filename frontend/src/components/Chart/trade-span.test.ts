import { describe, expect, it } from 'vitest';
import type { UTCTimestamp } from 'lightweight-charts';
import { TradeSpanPrimitive, spanPixels } from '@/components/Chart/trade-span';

describe('spanPixels', () => {
  it('sin coordenada de entrada o de salida no hay tramo que pintar', () => {
    expect(spanPixels(null, 120)).toBeNull();
    expect(spanPixels(40, null)).toBeNull();
  });

  it('ordena los extremos aunque lleguen al reves', () => {
    expect(spanPixels(160, 100)).toEqual({ left: 100, width: 60 });
  });

  it('una entrada y salida en la misma vela sigue ocupando un pixel', () => {
    expect(spanPixels(80, 80)).toEqual({ left: 80, width: 1 });
  });
});

describe('TradeSpanPrimitive', () => {
  const span = {
    from: 1_785_000_000 as UTCTimestamp,
    to: 1_785_003_600 as UTCTimestamp,
    fill: 'transparent',
    edge: 'green',
  };

  it('dibuja detras de las velas', () => {
    const view = new TradeSpanPrimitive().paneViews()[0];

    expect(view?.zOrder?.()).toBe('bottom');
  });

  it('sin adjuntar a una serie no pinta nada aunque tenga tramo', () => {
    const primitive = new TradeSpanPrimitive();
    primitive.setSpan(span);

    expect(primitive.span).toEqual(span);
    expect(primitive.paneViews()[0]?.renderer()).toBeNull();
  });

  it('quitar el tramo lo deja vacio', () => {
    const primitive = new TradeSpanPrimitive();
    primitive.setSpan(span);
    primitive.setSpan(null);

    expect(primitive.span).toBeNull();
  });
});
