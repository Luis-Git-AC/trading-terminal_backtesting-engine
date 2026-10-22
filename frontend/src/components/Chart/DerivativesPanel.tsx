import { useId, useMemo } from 'react';
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { Exchange, FundingResponse, OpenInterestResponse } from '@tt/shared';
import { EmptyState } from '@/components/Feedback/EmptyState';
import { ErrorState } from '@/components/Feedback/ErrorState';
import { Skeleton } from '@/components/Feedback/Skeleton';
import { formatAxisDate, formatTooltipDate } from '@/components/Results/EquityChart';
import { useFunding, useOpenInterest } from '@/hooks/useDerivatives';
import { formatCount, formatNumber } from '@/lib/format';
import styles from './DerivativesPanel.module.css';

export interface DerivativesPointView {
  readonly t: number;
  readonly ratePct: number | null;
  readonly oi: number | null;
}

/**
 * Funding y OI llegan en rejillas distintas (4 h y 1 h), asi que se mezclan por timestamp
 * para que el eje temporal sea el mismo que el del chart de velas.
 */
export function mergeSeries(
  funding: FundingResponse['funding'],
  openInterest: OpenInterestResponse['openInterest'],
): DerivativesPointView[] {
  const byTs = new Map<number, { ratePct: number | null; oi: number | null }>();

  for (const rate of funding) {
    byTs.set(rate.t, { ratePct: rate.rate * 100, oi: null });
  }

  for (const point of openInterest) {
    const existing = byTs.get(point.t);
    byTs.set(point.t, { ratePct: existing?.ratePct ?? null, oi: point.base });
  }

  return [...byTs.entries()]
    .sort(([left], [right]) => left - right)
    .map(([t, values]) => ({ t, ...values }));
}

export interface DerivativesPanelProps {
  readonly exchange: Exchange;
  readonly symbol: string;
  readonly from: number;
  readonly to: number;
}

export function DerivativesPanel({ exchange, symbol, from, to }: DerivativesPanelProps) {
  const request = { exchange, symbol, from, to };
  const funding = useFunding(request);
  const openInterest = useOpenInterest(request);

  const data = useMemo(
    () => mergeSeries(funding.data?.funding ?? [], openInterest.data?.openInterest ?? []),
    [funding.data, openInterest.data],
  );

  const gradientId = `oi-fill-${useId().replaceAll(':', '')}`;
  const error = funding.error ?? openInterest.error;

  if (error !== null) {
    return (
      <ErrorState
        error={error}
        title={`No se han podido cargar funding y OI de ${symbol}`}
        centered
        retrying={funding.isRefetching || openInterest.isRefetching}
        onRetry={() => {
          void funding.refetch();
          void openInterest.refetch();
        }}
      />
    );
  }

  if (funding.isPending || openInterest.isPending) {
    return <Skeleton label={`Cargando funding y OI de ${symbol}…`} lines={1} variant="block" />;
  }

  if (data.length === 0) {
    return (
      <EmptyState
        centered
        title={`Sin funding ni open interest de ${symbol} en este rango`}
        hint="El recolector de derivados aun no ha escrito nada para esta ventana temporal. Lanzalo y vuelve a esta vista."
        command={`npm run ingest -- --exchange ${exchange}`}
      />
    );
  }

  return (
    <div className={styles.chart} data-testid="derivatives-chart">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" style={{ stopColor: 'var(--color-accent)', stopOpacity: 0.28 }} />
              <stop offset="100%" style={{ stopColor: 'var(--color-accent)', stopOpacity: 0 }} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--color-border)" strokeDasharray="2 4" vertical={false} />
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={[from, to]}
            tickFormatter={formatAxisDate}
            stroke="var(--color-border-strong)"
            tick={{ fill: 'var(--color-text-tertiary)' }}
            tickLine={false}
            fontSize={11}
          />
          <YAxis
            yAxisId="funding"
            stroke="var(--color-border-strong)"
            tick={{ fill: 'var(--color-text-tertiary)' }}
            tickLine={false}
            axisLine={false}
            fontSize={11}
            width={64}
            domain={['auto', 'auto']}
            tickFormatter={(value: number) => `${formatNumber(value, 3)}%`}
          />
          <YAxis
            yAxisId="oi"
            orientation="right"
            stroke="var(--color-border-strong)"
            tick={{ fill: 'var(--color-text-tertiary)' }}
            tickLine={false}
            axisLine={false}
            fontSize={11}
            width={72}
            domain={['auto', 'auto']}
            tickFormatter={(value: number) => formatCount(value)}
          />
          <Tooltip
            labelFormatter={(label) => (typeof label === 'number' ? formatTooltipDate(label) : '')}
            formatter={(value, name) =>
              name === 'Funding (%)'
                ? `${formatNumber(Number(value), 4)}%`
                : formatCount(Number(value))
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
            yAxisId="oi"
            type="monotone"
            dataKey="oi"
            name="Open interest"
            stroke="var(--color-accent)"
            strokeWidth={1.5}
            fill={`url(#${gradientId})`}
            dot={false}
            connectNulls
            isAnimationActive={false}
          />
          <ReferenceLine yAxisId="funding" y={0} stroke="var(--color-border-strong)" />
          <Bar
            yAxisId="funding"
            dataKey="ratePct"
            name="Funding (%)"
            fill="var(--color-up)"
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
