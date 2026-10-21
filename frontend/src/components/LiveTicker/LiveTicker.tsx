import { cx } from '@/lib/cx';
import { formatSignedPercent, formatUsd } from '@/lib/format';
import { changePct, useLivePrice } from '@/state/live-price';
import styles from './LiveTicker.module.css';

export function formatPrice(price: number): string {
  return formatUsd(price);
}

export function formatChange(change: number): string {
  return formatSignedPercent(change);
}

export function LiveTicker() {
  const live = useLivePrice();

  if (live === null) {
    return null;
  }

  const change = changePct(live.price, live.referencePrice);

  return (
    <div className={styles.ticker} title={`Ultimo precio de ${live.symbol} en USD`}>
      <span
        key={live.seq}
        className={cx(
          styles.price,
          live.direction === 'up' && styles.flashUp,
          live.direction === 'down' && styles.flashDown,
        )}
        data-testid="live-price"
      >
        {formatPrice(live.price)}
      </span>
      {change === null ? null : (
        <span
          className={cx(styles.change, change > 0 && styles.up, change < 0 && styles.down)}
          title="Variacion en las ultimas 24 h"
        >
          {formatChange(change)}
        </span>
      )}
    </div>
  );
}
