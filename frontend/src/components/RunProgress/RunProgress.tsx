import { useEffect, useState } from 'react';
import type { RunStatus } from '@tt/shared';
import type { SseConnectionCtor } from '@/api/event-source';
import { describeApiError } from '@/api/errors';
import { EmptyState } from '@/components/Feedback/EmptyState';
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
import { isTerminalStatus, useRunProgress } from '@/hooks/useRunProgress';
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
      <EmptyState
        title="Ningun run seleccionado"
        hint="Configura la estrategia en el panel de la izquierda y pulsa «Ejecutar backtest»; el progreso y las metricas apareceran aqui."
      />
    );
  }

  const settled =
    isTerminalStatus(run.data?.status) && (live.status === undefined || isTerminalStatus(live.status));

  const persisted = run.data?.progress;
  const metrics = run.data?.metrics ?? null;

  const barsTotal = settled
    ? (persisted?.barsTotal ?? null)
    : (live.barsTotal ?? persisted?.barsTotal ?? null);
  const barsDone = settled
    ? (persisted?.barsDone ?? 0)
    : (live.progress?.barsDone ?? persisted?.barsDone ?? 0);
  const pct =
    !settled && live.progress !== undefined
      ? live.progress.pct
      : barsTotal !== null && barsTotal > 0
        ? (barsDone / barsTotal) * 100
        : 0;

  const trades = settled
    ? (metrics?.trades ?? live.progress?.trades ?? 0)
    : (live.progress?.trades ?? metrics?.trades ?? 0);

  const finalEquity =
    metrics === null || run.data === undefined
      ? undefined
      : String(run.data.exec.initialCapital + Number(metrics.netProfit));
  const equity = settled
    ? (finalEquity ?? live.progress?.equity)
    : (live.progress?.equity ?? finalEquity);

  const serverError = live.error?.message ?? run.data?.error ?? null;
  const finished = isTerminalStatus(status);

  return (
    <section className={styles.wrapper} aria-label="Progreso del backtest">
      <div className={styles.row}>
        <span className={cx(styles.badge, status !== undefined && styles[status])}>
          {status === undefined ? 'Conectando' : RUN_STATUS_LABEL[status]}
        </span>

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
            <dd>{formatCount(trades)}</dd>
          </div>
          <div className={styles.stat}>
            <dt>Equity</dt>
            <dd>{formatQuote(equity)}</dd>
          </div>
          <div className={styles.stat}>
            <dt>ETA</dt>
            <dd>{finished ? '—' : formatEta(live.progress?.etaMs ?? null)}</dd>
          </div>
        </dl>

        <div className={styles.identity}>
          {run.data?.label !== null && run.data?.label !== undefined && (
            <span className={styles.label}>{run.data.label}</span>
          )}
          <code className={styles.runId} title={runId}>
            {runId}
          </code>
        </div>

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
      </div>

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
