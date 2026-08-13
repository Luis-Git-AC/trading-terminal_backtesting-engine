import { useMemo } from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { CompareResponse, RunSummary } from '@tt/shared';
import { describeApiError } from '@/api/errors';
import {
  COMPARE_METRICS,
  MAX_COMPARE,
  MIN_COMPARE,
  bestIndex,
  metricNumber,
  mismatchWarnings,
} from '@/components/Compare/compare';
import { EMPTY_VALUE, metricCards } from '@/components/Results/metrics';
import { useCompareRuns } from '@/hooks/useCompare';
import { cx } from '@/lib/cx';
import styles from './Compare.module.css';

const CURVE_COLORS = [
  'var(--color-accent)',
  'var(--color-up)',
  'var(--color-warning)',
  'var(--color-down)',
];

export interface CompareViewProps {
  readonly ids: readonly string[];
}

function shortId(runId: string): string {
  return runId.slice(0, 8);
}

function runTitle(run: RunSummary): string {
  return run.label ?? `${run.strategyId} · ${shortId(run.id)}`;
}

export interface CurveRow {
  t: number;
  [runId: string]: number;
}

function curveColor(index: number): string {
  return CURVE_COLORS[index % CURVE_COLORS.length] ?? 'currentColor';
}

export function mergeCurves(curves: CompareResponse['curves']): CurveRow[] {
  const byTime = new Map<number, CurveRow>();

  for (const curve of curves) {
    for (const point of curve.points) {
      const row = byTime.get(point.t) ?? { t: point.t };
      row[curve.runId] = point.value;
      byTime.set(point.t, row);
    }
  }

  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

export function CompareView({ ids }: CompareViewProps) {
  const compare = useCompareRuns(ids);
  const runs = useMemo(() => compare.data?.runs ?? [], [compare.data]);

  const curveData = useMemo(() => mergeCurves(compare.data?.curves ?? []), [compare.data]);

  const formattedByRun = useMemo(
    () =>
      runs.map((run) =>
        run.metrics === null
          ? new Map<string, string>()
          : new Map(metricCards(run.metrics).map((card) => [card.key, card.value])),
      ),
    [runs],
  );

  if (ids.length < MIN_COMPARE) {
    return (
      <p className={styles.note}>
        Selecciona entre {MIN_COMPARE} y {MAX_COMPARE} runs para compararlos.
      </p>
    );
  }

  if (compare.isPending) {
    return <p className={styles.note}>Cargando comparativa…</p>;
  }

  if (compare.error !== null) {
    return <p className={styles.error}>{describeApiError(compare.error)}</p>;
  }

  const warnings = [...mismatchWarnings(runs), ...(compare.data?.warnings ?? [])];

  return (
    <div className={styles.compare}>
      {warnings.length > 0 && (
        <ul className={styles.warnings}>
          {warnings.map((warning) => (
            <li key={warning} className={styles.warning}>
              {warning}
            </li>
          ))}
        </ul>
      )}

      <div className={styles.curves} data-testid="compare-curves">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={curveData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="var(--color-border)" strokeDasharray="2 4" />
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={['dataMin', 'dataMax']}
              tickFormatter={(value: unknown) =>
                typeof value === 'number'
                  ? new Date(value).toLocaleDateString('es-ES', {
                      day: '2-digit',
                      month: 'short',
                      timeZone: 'UTC',
                    })
                  : ''
              }
              stroke="var(--color-text-tertiary)"
              fontSize={11}
            />
            <YAxis stroke="var(--color-text-tertiary)" fontSize={11} width={56} />
            <Tooltip
              labelFormatter={(label) =>
                typeof label === 'number' ? new Date(label).toISOString().slice(0, 16) : ''
              }
            />
            <Legend />
            {runs.map((run, index) => (
              <Line
                key={run.id}
                type="monotone"
                dataKey={run.id}
                name={runTitle(run)}
                stroke={curveColor(index)}
                strokeWidth={1.5}
                dot={false}
                connectNulls
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>

      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">Metrica</th>
            {runs.map((run) => (
              <th scope="col" key={run.id}>
                <span className={styles.runTitle}>{runTitle(run)}</span>
                <span className={styles.runMeta}>
                  {run.symbol} · {run.timeframe} · seed {run.seed}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {COMPARE_METRICS.map((metric) => {
            const values = runs.map((run) => metricNumber(run.metrics, metric.key));
            const winner = bestIndex(values, metric.better);

            return (
              <tr key={metric.key}>
                <th scope="row" className={styles.metricLabel}>
                  {metric.label}
                </th>
                {runs.map((run, index) => (
                  <td
                    key={run.id}
                    className={cx(styles.value, index === winner && styles.best)}
                    {...(index === winner ? { 'data-best': 'true' } : {})}
                  >
                    {formattedByRun[index]?.get(metric.key) ?? EMPTY_VALUE}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
