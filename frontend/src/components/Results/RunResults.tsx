import { useState, type KeyboardEvent } from 'react';
import type { BacktestTrade } from '@tt/shared';
import { EmptyState } from '@/components/Feedback/EmptyState';
import { ErrorState } from '@/components/Feedback/ErrorState';
import { Skeleton } from '@/components/Feedback/Skeleton';
import { EquityChart } from '@/components/Results/EquityChart';
import { MetricsGrid } from '@/components/Results/MetricsGrid';
import { TradesTable } from '@/components/Results/TradesTable';
import { useRun, useRunEquity, useRunTrades } from '@/hooks/useRuns';
import { cx } from '@/lib/cx';
import { formatCount } from '@/lib/format';
import styles from './Results.module.css';

export const RESULT_TABS = [
  { id: 'metrics', label: 'Metricas' },
  { id: 'equity', label: 'Equity y drawdown' },
  { id: 'trades', label: 'Operaciones' },
] as const;

export type ResultTab = (typeof RESULT_TABS)[number]['id'];

export function adjacentTab(current: ResultTab, key: string): ResultTab | null {
  const index = RESULT_TABS.findIndex((tab) => tab.id === current);
  const last = RESULT_TABS.length - 1;
  const next =
    key === 'ArrowRight'
      ? index === last
        ? 0
        : index + 1
      : key === 'ArrowLeft'
        ? index === 0
          ? last
          : index - 1
        : key === 'Home'
          ? 0
          : key === 'End'
            ? last
            : null;

  return next === null ? null : (RESULT_TABS[next]?.id ?? null);
}

export interface RunResultsProps {
  readonly runId: string | undefined;
  readonly selectedSeq?: number | undefined;
  readonly onSelectTrade?: ((trade: BacktestTrade) => void) | undefined;
}

export function RunResults({ runId, selectedSeq, onSelectTrade }: RunResultsProps) {
  const [tab, setTab] = useState<ResultTab>('metrics');

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

  const onTabKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    const next = adjacentTab(tab, event.key);
    if (next === null) {
      return;
    }
    event.preventDefault();
    setTab(next);
    document.getElementById(`results-tab-${next}`)?.focus();
  };

  return (
    <div className={styles.results}>
      <div
        className={styles.tabs}
        role="tablist"
        aria-label="Resultados del run"
        onKeyDown={onTabKey}
      >
        {RESULT_TABS.map((item) => {
          const active = item.id === tab;
          return (
            <button
              key={item.id}
              id={`results-tab-${item.id}`}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={`results-panel-${item.id}`}
              tabIndex={active ? 0 : -1}
              className={cx(styles.tab, active && styles.tabActive)}
              onClick={() => {
                setTab(item.id);
              }}
            >
              {item.label}
              {item.id === 'trades' && metrics !== null && (
                <span className={styles.tabCount} aria-hidden="true">
                  {formatCount(metrics.trades)}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div
        id="results-panel-metrics"
        role="tabpanel"
        aria-labelledby="results-tab-metrics"
        className={styles.tabPanel}
        hidden={tab !== 'metrics'}
      >
        {tab === 'metrics' &&
          (metrics === null ? (
            <EmptyState
              title="Sin metricas"
              hint="El run termino sin metricas persistidas."
            />
          ) : (
            <MetricsGrid metrics={metrics} />
          ))}
      </div>

      <div
        id="results-panel-equity"
        role="tabpanel"
        aria-labelledby="results-tab-equity"
        className={cx(styles.tabPanel, styles.tabPanelFill)}
        hidden={tab !== 'equity'}
      >
        {tab === 'equity' &&
          (equity.isPending ? (
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
          ))}
      </div>

      <div
        id="results-panel-trades"
        role="tabpanel"
        aria-labelledby="results-tab-trades"
        className={styles.tabPanel}
        hidden={tab !== 'trades'}
      >
        {tab === 'trades' &&
          (trades.isPending ? (
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
          ))}
      </div>
    </div>
  );
}
