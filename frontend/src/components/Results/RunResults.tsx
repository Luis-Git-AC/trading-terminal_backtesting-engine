import type { BacktestTrade } from '@tt/shared';
import { EmptyState } from '@/components/Feedback/EmptyState';
import { ErrorState } from '@/components/Feedback/ErrorState';
import { Skeleton } from '@/components/Feedback/Skeleton';
import { EquityChart } from '@/components/Results/EquityChart';
import { MetricsGrid } from '@/components/Results/MetricsGrid';
import { TradesTable } from '@/components/Results/TradesTable';
import { useRun, useRunEquity, useRunTrades } from '@/hooks/useRuns';
import styles from './Results.module.css';

export interface RunResultsProps {
  readonly runId: string | undefined;
  readonly selectedSeq?: number | undefined;
  readonly onSelectTrade?: ((trade: BacktestTrade) => void) | undefined;
}

export function RunResults({ runId, selectedSeq, onSelectTrade }: RunResultsProps) {
  const run = useRun(runId);
  const completed = run.data?.status === 'completed';
  const enabled = completed && runId !== undefined;

  const trades = useRunTrades(enabled ? { runId } : undefined);
  const equity = useRunEquity(enabled ? runId : undefined);

  if (runId === undefined) {
    return null;
  }

  if (run.error !== null) {
    return (
      <ErrorState
        error={run.error}
        title="No se ha podido cargar el run"
        retrying={run.isRefetching}
        onRetry={() => {
          void run.refetch();
        }}
      />
    );
  }

  if (!completed) {
    return null;
  }

  const metrics = run.data?.metrics ?? null;

  return (
    <div className={styles.results}>
      {metrics !== null && (
        <section>
          <h3 className={styles.sectionTitle}>Metricas</h3>
          <MetricsGrid metrics={metrics} />
        </section>
      )}

      <section>
        <h3 className={styles.sectionTitle}>Equity y drawdown</h3>
        {equity.isPending ? (
          <Skeleton label="Cargando la curva de equity…" lines={3} />
        ) : equity.error !== null ? (
          <ErrorState
            error={equity.error}
            title="No se ha podido cargar la curva"
            retrying={equity.isRefetching}
            onRetry={() => {
              void equity.refetch();
            }}
          />
        ) : (equity.data?.points.length ?? 0) === 0 ? (
          <EmptyState
            title="Sin curva de equity"
            hint="El run termino sin producir puntos de equity: no llego a abrir ninguna posicion."
          />
        ) : (
          <EquityChart points={equity.data?.points ?? []} />
        )}
      </section>

      <section>
        <h3 className={styles.sectionTitle}>Operaciones</h3>
        {trades.isPending ? (
          <Skeleton label="Cargando operaciones…" lines={4} />
        ) : trades.error !== null ? (
          <ErrorState
            error={trades.error}
            title="No se han podido cargar las operaciones"
            retrying={trades.isRefetching}
            onRetry={() => {
              void trades.refetch();
            }}
          />
        ) : (
          <TradesTable
            trades={trades.data?.trades ?? []}
            totalTrades={metrics?.trades}
            selectedSeq={selectedSeq}
            onSelect={onSelectTrade}
          />
        )}
      </section>
    </div>
  );
}
