import { useState } from 'react';
import { useNavigate } from 'react-router';
import { RUN_STATUSES, type RunStatus, type RunSummary } from '@tt/shared';
import { CompareView } from '@/components/Compare/CompareView';
import { MAX_COMPARE, canCompare, toggleSelection } from '@/components/Compare/compare';
import { EmptyState } from '@/components/Feedback/EmptyState';
import { ErrorState } from '@/components/Feedback/ErrorState';
import { Skeleton } from '@/components/Feedback/Skeleton';
import { Panel } from '@/components/Panel/Panel';
import { RUN_STATUS_LABEL } from '@/components/RunProgress/format';
import { useDeleteBacktest } from '@/hooks/useBacktest';
import { useRuns } from '@/hooks/useRuns';
import { cx } from '@/lib/cx';
import styles from './Runs.module.css';

export const ALL = 'todas';

function formatDay(iso: string): string {
  return iso.slice(0, 10);
}

function shortMetric(run: RunSummary): string {
  if (run.metrics === null) {
    return '—';
  }
  return `${Number(run.metrics.netProfit).toFixed(2)} · ${String(run.metrics.trades)} ops`;
}

export function Runs() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<RunStatus | typeof ALL>(ALL);
  const [strategy, setStrategy] = useState<string>(ALL);
  const [selected, setSelected] = useState<string[]>([]);
  const [confirming, setConfirming] = useState<string | null>(null);

  const runs = useRuns(status === ALL ? {} : { status });
  const remove = useDeleteBacktest();

  const all = runs.data?.runs ?? [];
  const strategies = [...new Set(all.map((run) => run.strategyId))].sort();
  const visible = strategy === ALL ? all : all.filter((run) => run.strategyId === strategy);
  const filtering = status !== ALL || strategy !== ALL;

  return (
    <div className={styles.page}>
      <Panel
        title="Historial de runs"
        className={styles.history}
        meta={`${String(visible.length)} runs`}
        actions={
          <div className={styles.filters}>
            <label className={styles.filter}>
              <span className={styles.filterLabel}>Estado</span>
              <select
                className={styles.select}
                value={status}
                onChange={(event) => {
                  const next = event.target.value;
                  setStatus(next === ALL ? ALL : (next as RunStatus));
                }}
              >
                <option value={ALL}>Todos</option>
                {RUN_STATUSES.map((option) => (
                  <option key={option} value={option}>
                    {RUN_STATUS_LABEL[option]}
                  </option>
                ))}
              </select>
            </label>

            <label className={styles.filter}>
              <span className={styles.filterLabel}>Estrategia</span>
              <select
                className={styles.select}
                value={strategy}
                onChange={(event) => {
                  setStrategy(event.target.value);
                }}
              >
                <option value={ALL}>Todas</option>
                {strategies.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
          </div>
        }
      >
        {runs.error !== null ? (
          <ErrorState
            error={runs.error}
            title="No se ha podido cargar el historial"
            retrying={runs.isRefetching}
            onRetry={() => {
              void runs.refetch();
            }}
          />
        ) : runs.isPending ? (
          <Skeleton label="Cargando runs…" lines={6} />
        ) : visible.length === 0 ? (
          filtering ? (
            <EmptyState
              title="Ningun run coincide con los filtros"
              hint="Ninguno de los runs guardados cumple el filtro actual de estado y estrategia."
              action={
                <button
                  type="button"
                  className={styles.action}
                  onClick={() => {
                    setStatus(ALL);
                    setStrategy(ALL);
                  }}
                >
                  Quitar los filtros
                </button>
              }
            />
          ) : (
            <EmptyState
              title="Todavia no hay ningun run"
              hint="Configura una estrategia en la terminal y pulsa «Ejecutar backtest»; el run aparecera aqui en cuanto lo recoja el worker."
              action={
                <button
                  type="button"
                  className={styles.action}
                  onClick={() => {
                    void navigate('/');
                  }}
                >
                  Ir a la terminal
                </button>
              }
            />
          )
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">
                  <span className={styles.srOnly}>Comparar</span>
                </th>
                <th scope="col">Fecha</th>
                <th scope="col">Estrategia</th>
                <th scope="col">Serie</th>
                <th scope="col">Rango</th>
                <th scope="col">Seed</th>
                <th scope="col">Resultado</th>
                <th scope="col">Estado</th>
                <th scope="col">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((run) => {
                const checked = selected.includes(run.id);
                const atLimit = !checked && selected.length >= MAX_COMPARE;

                return (
                  <tr key={run.id} className={cx(checked && styles.rowSelected)}>
                    <td>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={atLimit}
                        aria-label={`Comparar el run ${run.id}`}
                        onChange={() => {
                          setSelected((current) => toggleSelection(current, run.id));
                        }}
                      />
                    </td>
                    <td className={styles.mono}>{formatDay(run.timings.createdAt)}</td>
                    <td>{run.strategyId}</td>
                    <td className={styles.mono}>
                      {run.symbol} {run.timeframe}
                    </td>
                    <td className={styles.mono}>
                      {formatDay(run.range.from)} → {formatDay(run.range.to)}
                    </td>
                    <td className={styles.mono}>{run.seed}</td>
                    <td className={styles.mono}>{shortMetric(run)}</td>
                    <td>{RUN_STATUS_LABEL[run.status]}</td>
                    <td>
                      {confirming === run.id ? (
                        <span className={styles.confirm}>
                          <span className={styles.confirmText}>¿Borrar?</span>
                          <button
                            type="button"
                            className={styles.danger}
                            onClick={() => {
                              remove.mutate(run.id);
                              setConfirming(null);
                              setSelected((current) => current.filter((id) => id !== run.id));
                            }}
                          >
                            Si
                          </button>
                          <button
                            type="button"
                            className={styles.action}
                            onClick={() => {
                              setConfirming(null);
                            }}
                          >
                            No
                          </button>
                        </span>
                      ) : (
                        <span className={styles.actions}>
                          <button
                            type="button"
                            className={styles.action}
                            onClick={() => {
                              void navigate(`/?run=${run.id}`);
                            }}
                          >
                            Ver
                          </button>
                          <button
                            type="button"
                            className={styles.action}
                            onClick={() => {
                              void navigate(`/?duplicate=${run.id}`);
                            }}
                          >
                            Duplicar
                          </button>
                          <button
                            type="button"
                            className={styles.action}
                            onClick={() => {
                              setConfirming(run.id);
                            }}
                          >
                            Borrar
                          </button>
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel
        title="Comparador"
        className={styles.compare}
        meta={`${String(selected.length)}/${String(MAX_COMPARE)} seleccionados`}
        actions={
          selected.length > 0 ? (
            <button
              type="button"
              className={styles.action}
              onClick={() => {
                setSelected([]);
              }}
            >
              Limpiar
            </button>
          ) : undefined
        }
      >
        {selected.length >= MAX_COMPARE && (
          <p className={styles.note}>
            Maximo {MAX_COMPARE} runs a la vez; deselecciona uno para elegir otro.
          </p>
        )}
        <CompareView ids={canCompare(selected) ? selected : []} />
      </Panel>
    </div>
  );
}
