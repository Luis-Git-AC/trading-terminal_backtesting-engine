import { useId, useMemo } from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { EquityResponse } from '@tt/shared';
import { formatPercent, formatUsd } from '@/lib/format';
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
  const gradientId = `equity-fill-${useId().replaceAll(':', '')}`;

  if (data.length === 0) {
    return <p className={styles.empty}>El run no dejo curva de equity.</p>;
  }

  return (
    <div className={styles.equity} data-testid="equity-chart">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" style={{ stopColor: 'var(--color-accent)', stopOpacity: 0.32 }} />
              <stop offset="100%" style={{ stopColor: 'var(--color-accent)', stopOpacity: 0 }} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--color-border)" strokeDasharray="2 4" vertical={false} />
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={['dataMin', 'dataMax']}
            tickFormatter={formatAxisDate}
            stroke="var(--color-border-strong)"
            tick={{ fill: 'var(--color-text-tertiary)' }}
            tickLine={false}
            fontSize={11}
          />
          <YAxis
            yAxisId="equity"
            stroke="var(--color-border-strong)"
            tick={{ fill: 'var(--color-text-tertiary)' }}
            tickLine={false}
            axisLine={false}
            fontSize={11}
            width={72}
            domain={['auto', 'auto']}
            tickFormatter={(value: number) => formatUsd(value, 0)}
          />
          <YAxis yAxisId="dd" orientation="right" hide domain={[0, 'dataMax']} reversed />
          <Tooltip
            labelFormatter={(label) => (typeof label === 'number' ? formatTooltipDate(label) : '')}
            formatter={(value, name) =>
              name === 'Equity' ? formatUsd(Number(value)) : formatPercent(Number(value))
            }
            cursor={{ stroke: 'var(--color-accent)', strokeDasharray: '3 3' }}
            contentStyle={{
              background: 'var(--color-surface-raised)',
              border: '1px solid var(--color-border-strong)',
              borderRadius: 'var(--radius-md)',
              boxShadow: 'var(--shadow-md)',
              color: 'var(--color-text)',
              fontFamily: 'var(--font-mono)',
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
            fillOpacity={0.22}
            isAnimationActive={false}
          />
          <Area
            yAxisId="equity"
            type="monotone"
            dataKey="equity"
            name="Equity"
            stroke="var(--color-accent)"
            strokeWidth={1.75}
            fill={`url(#${gradientId})`}
            dot={false}
            activeDot={{ r: 3, fill: 'var(--color-accent)', stroke: 'var(--color-bg)' }}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
