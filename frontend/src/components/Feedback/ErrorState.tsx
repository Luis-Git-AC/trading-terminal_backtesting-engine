import { describeApiError, isApiError, recoveryHintFor } from '@/api/errors';
import { cx } from '@/lib/cx';
import styles from './Feedback.module.css';

export interface ErrorStateProps {
  readonly error: unknown;
  readonly title?: string;
  readonly onRetry?: (() => void) | undefined;
  readonly retrying?: boolean | undefined;
  readonly centered?: boolean | undefined;
}

export function ErrorState({
  error,
  title = 'No se ha podido cargar',
  onRetry,
  retrying = false,
  centered = false,
}: ErrorStateProps) {
  const recovery = recoveryHintFor(error);

  return (
    <div className={cx(styles.state, centered && styles.centered)} role="alert">
      <p className={cx(styles.title, styles.alarming)}>{title}</p>
      <p className={styles.hint}>{describeApiError(error)}</p>
      {recovery === null ? null : <p className={styles.hint}>{recovery}</p>}
      {isApiError(error) && <p className={styles.code}>{error.code}</p>}
      {onRetry === undefined ? null : (
        <button type="button" className={styles.retry} disabled={retrying} onClick={onRetry}>
          {retrying ? 'Reintentando…' : 'Reintentar'}
        </button>
      )}
    </div>
  );
}
