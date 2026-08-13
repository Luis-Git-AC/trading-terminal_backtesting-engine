import { useMemo } from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { EquityResponse } from '@tt/shared';
import styles from './Results.module.css';

export interface EquityPointView {
  readonly t: number;
  readonly equity: number;
  readonly drawdownPct: number;
}

export function toEquityView(points: EquityResponse['points']): EquityPointView[] {
  return points.map((point) => ({
    t: point.t,
    equity: Number(point.equity),
    drawdownPct: point.dd * 100,
  }));
}

export function formatTooltipDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 16).replace('T', ' ');
}

export function formatAxisDate(ts: number): string {
  return new Date(ts).toLocaleDateString('es-ES', {
    day: '2-digit',
    month: 'short',
    timeZone: 'UTC',
  });
}

export interface EquityChartProps {
  readonly points: EquityResponse['points'];
}

export function EquityChart({ points }: EquityChartProps) {
  const data = useMemo(() => toEquityView(points), [points]);

  if (data.length === 0) {
    return <p className={styles.empty}>El run no dejo curva de equity.</p>;
  }

  return (
    <div className={styles.equity} data-testid="equity-chart">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="var(--color-border)" strokeDasharray="2 4" />
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={['dataMin', 'dataMax']}
            tickFormatter={formatAxisDate}
            stroke="var(--color-text-tertiary)"
            fontSize={11}
          />
          <YAxis
            yAxisId="equity"
            stroke="var(--color-text-tertiary)"
            fontSize={11}
            width={64}
            domain={['auto', 'auto']}
          />
          <YAxis yAxisId="dd" orientation="right" hide domain={[0, 'dataMax']} reversed />
          <Tooltip
            labelFormatter={(label) => (typeof label === 'number' ? formatTooltipDate(label) : '')}
            contentStyle={{
              background: 'var(--color-surface-raised)',
              border: '1px solid var(--color-border-strong)',
              borderRadius: 'var(--radius-md)',
              fontSize: 'var(--font-size-sm)',
            }}
          />
          <Area
            yAxisId="dd"
            type="monotone"
            dataKey="drawdownPct"
            name="Drawdown (%)"
            stroke="none"
            fill="var(--color-down)"
            fillOpacity={0.18}
            isAnimationActive={false}
          />
          <Line
            yAxisId="equity"
            type="monotone"
            dataKey="equity"
            name="Equity"
            stroke="var(--color-accent)"
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
