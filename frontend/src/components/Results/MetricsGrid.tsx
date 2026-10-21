import type { BacktestMetricsResponse } from '@tt/shared';
import { EMPTY_VALUE, metricCards } from '@/components/Results/metrics';
import { cx } from '@/lib/cx';
import styles from './Results.module.css';

export interface MetricsGridProps {
  readonly metrics: BacktestMetricsResponse;
}

export const LEAD_METRICS = 2;

export function MetricsGrid({ metrics }: MetricsGridProps) {
  return (
    <dl className={styles.metrics}>
      {metricCards(metrics).map((item, index) => {
        const up = item.tone === 'signed' && item.sign > 0;
        const down =
          (item.tone === 'signed' && item.sign < 0) || (item.tone === 'inverse' && item.sign !== 0);

        return (
          <div
            className={cx(
              styles.metric,
              index < LEAD_METRICS && styles.metricLead,
              up && styles.metricUp,
              down && styles.metricDown,
            )}
            key={item.key}
            style={{ '--stagger-index': index }}
          >
            <dt className={styles.metricLabel} title={item.label}>
              {item.label}
            </dt>
            <dd
              className={cx(
                styles.metricValue,
                up && styles.positive,
                down && styles.negative,
                item.value === EMPTY_VALUE && styles.muted,
              )}
              {...(item.hint === undefined ? {} : { title: item.hint })}
            >
              {item.value}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
