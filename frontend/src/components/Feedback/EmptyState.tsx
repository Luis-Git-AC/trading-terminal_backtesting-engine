import type { ReactNode } from 'react';
import { cx } from '@/lib/cx';
import styles from './Feedback.module.css';

export interface EmptyStateProps {
  readonly title: string;
  readonly hint?: ReactNode;
  readonly command?: string | undefined;
  readonly action?: ReactNode;
  readonly centered?: boolean | undefined;
}

export function EmptyState({ title, hint, command, action, centered = false }: EmptyStateProps) {
  return (
    <div className={cx(styles.state, centered && styles.centered)} role="status">
      <p className={styles.title}>{title}</p>
      {hint === undefined ? null : <p className={styles.hint}>{hint}</p>}
      {command === undefined ? null : <code className={styles.command}>{command}</code>}
      {action}
    </div>
  );
}
