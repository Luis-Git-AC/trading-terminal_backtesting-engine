import type { BacktestTrade } from '@tt/shared';
import { describeApiError } from '@/api/errors';
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
    return <p className={styles.empty}>{describeApiError(run.error)}</p>;
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
          <p className={styles.empty}>Cargando la curva…</p>
        ) : (
          <EquityChart points={equity.data?.points ?? []} />
        )}
      </section>

      <section>
        <h3 className={styles.sectionTitle}>Operaciones</h3>
        {trades.isPending ? (
          <p className={styles.empty}>Cargando operaciones…</p>
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
