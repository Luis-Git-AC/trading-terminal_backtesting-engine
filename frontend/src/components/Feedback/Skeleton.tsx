import { cx } from '@/lib/cx';
import styles from './Feedback.module.css';

export interface SkeletonProps {
  readonly label: string;
  readonly lines?: number | undefined;
  readonly variant?: 'text' | 'block' | undefined;
}

export function Skeleton({ label, lines = 3, variant = 'text' }: SkeletonProps) {
  return (
    <div className={styles.skeleton} role="status" aria-busy="true" aria-label={label}>
      {Array.from({ length: Math.max(1, lines) }, (_, index) => (
        <span key={index} className={cx(styles.bar, variant === 'block' && styles.block)} />
      ))}
    </div>
  );
}
