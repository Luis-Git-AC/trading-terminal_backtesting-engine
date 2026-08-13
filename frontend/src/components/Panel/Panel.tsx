import type { ReactNode } from 'react';
import { cx } from '@/lib/cx';
import styles from './Panel.module.css';

export interface PanelProps {
  title: string;
  meta?: ReactNode;
  actions?: ReactNode;
  scroll?: boolean | undefined;
  className?: string | undefined;
  children?: ReactNode;
}

export function Panel({ title, meta, actions, scroll = true, className, children }: PanelProps) {
  return (
    <section className={cx(styles.panel, className)}>
      <div className={styles.head}>
        <h2 className={styles.title}>{title}</h2>
        {meta === undefined ? null : <span className={styles.meta}>{meta}</span>}
        {actions === undefined ? null : <div className={styles.actions}>{actions}</div>}
      </div>
      <div className={cx(styles.body, scroll && styles.scrollable)}>{children}</div>
    </section>
  );
}
