import { Line, LineChart, ResponsiveContainer, YAxis } from 'recharts';
import type { MacroSeriesResponse } from '@tt/shared';
import { EmptyState } from '@/components/Feedback/EmptyState';
import { ErrorState } from '@/components/Feedback/ErrorState';
import { Skeleton } from '@/components/Feedback/Skeleton';
import { eventLabel, type MarketEventView } from '@/components/Chart/markers';
import {
  MACRO_LOOKBACK_MS,
  macroSeriesFor,
  type MacroSeriesSpec,
  type MacroUnit,
} from '@/components/Panel/macro-context';
import { useMacroSeries } from '@/hooks/useMacro';
import { formatCount, formatNumber, formatUsd } from '@/lib/format';
import styles from './MacroPanel.module.css';

export function formatMacroValue(value: number, unit: MacroUnit): string {
  switch (unit) {
    case 'percent':
      return `${formatNumber(value, 2)} %`;
    case 'usd':
      return formatUsd(value, 0);
    case 'kbarrels':
      return `${formatCount(value)} kb`;
    default:
      return formatNumber(value, 2);
  }
}

export function formatEventDate(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

interface MacroSeriesCardProps {
  readonly spec: MacroSeriesSpec;
  readonly to: number;
}

function MacroSeriesCard({ spec, to }: MacroSeriesCardProps) {
  const query = useMacroSeries({
    seriesId: spec.seriesId,
    source: spec.source,
    from: to - MACRO_LOOKBACK_MS,
    to,
  });

  return (
    <article className={styles.card} data-testid={`macro-card-${spec.seriesId}`}>
      <h3 className={styles.cardTitle}>{spec.label}</h3>
      {query.error !== null ? (
        <ErrorState
          error={query.error}
          title={`No se ha podido cargar ${spec.label}`}
          retrying={query.isRefetching}
          onRetry={() => {
            void query.refetch();
          }}
        />
      ) : query.isPending ? (
        <Skeleton label={`Cargando ${spec.label}…`} lines={2} />
      ) : (
        <MacroSeriesBody spec={spec} data={query.data} />
      )}
    </article>
  );
}

function MacroSeriesBody({
  spec,
  data,
}: {
  readonly spec: MacroSeriesSpec;
  readonly data: MacroSeriesResponse;
}) {
  const last = data.points.at(-1);

  if (last === undefined) {
    return (
      <EmptyState
        title="Sin datos recogidos todavia"
        hint={`El collector aun no ha escrito ${spec.seriesId}.`}
        command="docker compose up -d collector"
      />
    );
  }

  return (
    <>
      <p className={styles.value}>
        <span className={styles.number}>{formatMacroValue(last.value, spec.unit)}</span>
        <span className={styles.date}>{formatEventDate(last.t)}</span>
      </p>
      <div className={styles.spark} aria-hidden="true">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={[...data.points]} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
            <YAxis hide domain={['dataMin', 'dataMax']} />
            <Line
              type="monotone"
              dataKey="value"
              stroke="var(--color-accent)"
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <p className={styles.caption}>
        {data.source} · {String(data.count)} puntos · 180 d
      </p>
    </>
  );
}

export interface MacroPanelProps {
  readonly symbol: string;
  /** Final de la ventana de velas cargada: el contexto macro se mira hacia atras desde ahi. */
  readonly to: number;
  readonly events: readonly MarketEventView[];
  readonly eventsPending?: boolean | undefined;
}

export function MacroPanel({ symbol, to, events, eventsPending = false }: MacroPanelProps) {
  const specs = macroSeriesFor(symbol);

  return (
    <div className={styles.panel}>
      <section className={styles.events} aria-label="Eventos del rango">
        <h3 className={styles.cardTitle}>Eventos del rango</h3>
        {eventsPending ? (
          <Skeleton label="Cargando eventos…" lines={2} />
        ) : events.length === 0 ? (
          <EmptyState
            title="Ningun evento en este rango"
            hint="Ni publicaciones del FRED, ni informes de la EIA, ni COT dentro de la ventana cargada."
          />
        ) : (
          <ul className={styles.eventList}>
            {events.map((event) => (
              <li key={`${event.type}-${String(event.scheduledAt)}`} className={styles.event}>
                <span className={styles.eventDate}>{formatEventDate(event.scheduledAt)}</span>
                <span className={styles.eventLabel}>{eventLabel(event)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className={styles.cards}>
        {specs.map((spec) => (
          <MacroSeriesCard key={`${spec.source}-${spec.seriesId}`} spec={spec} to={to} />
        ))}
      </div>
    </div>
  );
}
