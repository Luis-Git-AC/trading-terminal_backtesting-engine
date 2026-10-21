import { render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { describe, expect, it } from 'vitest';
import type { Candle } from '@tt/shared';
import { LiveTicker, formatChange, formatPrice } from '@/components/LiveTicker/LiveTicker';
import {
  LivePriceProvider,
  usePublishLivePrice,
  type LivePriceUpdate,
} from '@/state/live-price';

function candle(c: number): Candle {
  return { t: 0, o: c, h: c, l: c, c, v: 1 };
}

function Publisher({ update }: { readonly update: LivePriceUpdate | null }) {
  const publish = usePublishLivePrice();

  useEffect(() => {
    publish(update);
  }, [publish, update]);

  return null;
}

function tree(update: LivePriceUpdate | null) {
  return (
    <LivePriceProvider>
      <Publisher update={update} />
      <LiveTicker />
    </LivePriceProvider>
  );
}

describe('formato del ticker', () => {
  it('el precio va en dolares, como la cotizacion en USDT del par', () => {
    expect(formatPrice(66_418.2)).toBe('$66,418.20');
  });

  it('la variacion lleva signo explicito solo cuando sube', () => {
    expect(formatChange(2.1818)).toBe('+2.18%');
    expect(formatChange(-1.5)).toBe('-1.50%');
    expect(formatChange(0)).toBe('0.00%');
  });
});

describe('LiveTicker', () => {
  it('sin precio publicado no pinta nada', () => {
    render(tree(null));

    expect(screen.queryByTestId('live-price')).toBeNull();
  });

  it('pinta el ultimo precio y la variacion de 24 h', () => {
    render(tree({ symbol: 'BTCUSDT', candle: candle(66_418.2), referencePrice: 65_000 }));

    expect(screen.getByTestId('live-price').textContent).toBe('$66,418.20');
    expect(screen.getByText('+2.18%')).toBeDefined();
  });

  it('sin referencia de 24 h no inventa la variacion', () => {
    render(tree({ symbol: 'BTCUSDT', candle: candle(66_418.2), referencePrice: null }));

    expect(screen.getByTestId('live-price')).toBeDefined();
    expect(screen.queryByText(/%$/)).toBeNull();
  });

  it('al retirar el precio desaparece', () => {
    const { rerender } = render(
      tree({ symbol: 'BTCUSDT', candle: candle(66_418.2), referencePrice: null }),
    );

    rerender(tree(null));

    expect(screen.queryByTestId('live-price')).toBeNull();
  });
});
