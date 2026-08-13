import type { BacktestMetricsResponse } from '@tt/shared';
import { EMPTY_VALUE, metricCards } from '@/components/Results/metrics';
import { cx } from '@/lib/cx';
import styles from './Results.module.css';

export interface MetricsGridProps {
  readonly metrics: BacktestMetricsResponse;
}

export function MetricsGrid({ metrics }: MetricsGridProps) {
  return (
    <dl className={styles.metrics}>
      {metricCards(metrics).map((item) => (
        <div className={styles.metric} key={item.key}>
          <dt className={styles.metricLabel}>{item.label}</dt>
          <dd
            className={cx(
              styles.metricValue,
              item.tone === 'signed' && item.sign > 0 && styles.positive,
              item.tone === 'signed' && item.sign < 0 && styles.negative,
              item.tone === 'inverse' && item.sign !== 0 && styles.negative,
              item.value === EMPTY_VALUE && styles.muted,
            )}
            {...(item.hint === undefined ? {} : { title: item.hint })}
          >
            {item.value}
          </dd>
        </div>
      ))}
      {metrics.openAtEnd && (
        <p className={styles.openAtEnd}>
          El run acabo con una posicion abierta que se cerro a la fuerza al agotarse los datos.
        </p>
      )}
    </dl>
  );
}
