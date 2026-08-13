import { useEffect, useState } from 'react';
import type { RunStatus } from '@tt/shared';
import type { SseConnectionCtor } from '@/api/event-source';
import { describeApiError } from '@/api/errors';
import {
  RUN_STATUS_LABEL,
  barsLabel,
  formatCount,
  formatEta,
  formatPct,
  formatQuote,
  isCancellable,
} from '@/components/RunProgress/format';
import { useCancelBacktest } from '@/hooks/useBacktest';
import { useRun } from '@/hooks/useRuns';
import { useRunProgress } from '@/hooks/useRunProgress';
import { cx } from '@/lib/cx';
import styles from './RunProgress.module.css';

export const STALLED_QUEUE_MS = 10_000;

export interface RunProgressProps {
  readonly runId: string | undefined;
  readonly onDismiss?: (() => void) | undefined;
  readonly sseCtor?: SseConnectionCtor | undefined;
  readonly stalledQueueMs?: number | undefined;
}

export function RunProgress({
  runId,
  onDismiss,
  sseCtor,
  stalledQueueMs = STALLED_QUEUE_MS,
}: RunProgressProps) {
  const live = useRunProgress(runId, { ctor: sseCtor });
  const run = useRun(runId);
  const cancel = useCancelBacktest();

  const status: RunStatus | undefined = live.status ?? run.data?.status;

  const [stalledKey, setStalledKey] = useState<string | null>(null);
  const queueKey = `${runId ?? ''}:${status ?? ''}`;
  const queueStalled = stalledKey === queueKey;

  useEffect(() => {
    if (runId === undefined || status !== 'queued') {
      return;
    }

    const timer = setTimeout(() => {
      setStalledKey(`${runId}:${status}`);
    }, stalledQueueMs);

    return () => {
      clearTimeout(timer);
    };
  }, [runId, status, stalledQueueMs]);

  if (runId === undefined) {
    return (
      <p className={styles.idle}>
        Configura la estrategia y pulsa «Ejecutar backtest» para lanzar un run.
      </p>
    );
  }

  const barsTotal = live.barsTotal ?? run.data?.progress.barsTotal ?? null;
  const barsDone = live.progress?.barsDone ?? run.data?.progress.barsDone ?? 0;
  const pct =
    live.progress?.pct ?? (barsTotal !== null && barsTotal > 0 ? (barsDone / barsTotal) * 100 : 0);

  const serverError = live.error?.message ?? run.data?.error ?? null;
  const finished = status === 'completed' || status === 'failed' || status === 'cancelled';

  return (
    <section className={styles.wrapper} aria-label="Progreso del backtest">
      <header className={styles.head}>
        <span className={cx(styles.badge, status !== undefined && styles[status])}>
          {status === undefined ? 'Conectando' : RUN_STATUS_LABEL[status]}
        </span>
        <code className={styles.runId}>{runId}</code>
        {run.data?.label !== null && run.data?.label !== undefined && (
          <span className={styles.label}>{run.data.label}</span>
        )}
        <div className={styles.actions}>
          {isCancellable(status) && (
            <button
              type="button"
              className={styles.cancel}
              disabled={cancel.isPending}
              onClick={() => {
                cancel.mutate(runId);
              }}
            >
              {cancel.isPending ? 'Cancelando…' : 'Cancelar'}
            </button>
          )}
          {finished && onDismiss !== undefined && (
            <button type="button" className={styles.dismiss} onClick={onDismiss}>
              Cerrar
            </button>
          )}
        </div>
      </header>

      {!finished && (
        <div
          className={styles.track}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pct)}
        >
          <div
            className={cx(styles.fill, status === 'queued' && styles.fillQueued)}
            style={{ width: `${String(Math.min(100, Math.max(0, pct)))}%` }}
          />
        </div>
      )}

      <dl className={styles.stats}>
        <div className={styles.stat}>
          <dt>Progreso</dt>
          <dd>{formatPct(pct)}</dd>
        </div>
        <div className={styles.stat}>
          <dt>Barras</dt>
          <dd>{barsLabel(barsDone, barsTotal)}</dd>
        </div>
        <div className={styles.stat}>
          <dt>Trades</dt>
          <dd>{formatCount(live.progress?.trades ?? run.data?.metrics?.trades ?? 0)}</dd>
        </div>
        <div className={styles.stat}>
          <dt>Equity</dt>
          <dd>{formatQuote(live.progress?.equity ?? run.data?.metrics?.netProfit)}</dd>
        </div>
        <div className={styles.stat}>
          <dt>ETA</dt>
          <dd>{finished ? '—' : formatEta(live.progress?.etaMs ?? null)}</dd>
        </div>
      </dl>

      {status === 'queued' && (
        <p className={cx(styles.hint, queueStalled && styles.hintWarning)}>
          {queueStalled
            ? 'Sigue en cola: no hay ningun worker recogiendo el trabajo. Arranca "npm run dev:worker".'
            : 'Esperando a que un worker lo recoja…'}
        </p>
      )}

      {serverError !== null && <p className={styles.failure}>{serverError}</p>}

      {cancel.error !== null && <p className={styles.failure}>{describeApiError(cancel.error)}</p>}

      {live.connectionState === 'disconnected' && !finished && (
        <p className={styles.hint}>Sin conexion con el stream de progreso; reintentando…</p>
      )}
    </section>
  );
}
