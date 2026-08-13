import type { HealthResponse } from '@tt/shared';
import type { ConnectionState } from '@/hooks/useEventSource';
import { useHealth } from '@/hooks/useHealth';
import { cx } from '@/lib/cx';
import { useLiveStatus } from '@/state/live-status';
import styles from './ConnectionBadge.module.css';

export const FEED_TONES = ['live', 'connecting', 'stale', 'offline'] as const;

export type FeedTone = (typeof FEED_TONES)[number];

export const FEED_LABEL: Record<FeedTone, string> = {
  live: 'En vivo',
  connecting: 'Conectando',
  stale: 'Datos atrasados',
  offline: 'Sin conexion',
};

export interface IngestSummary {
  readonly degraded: boolean;
  readonly lastCandleAgeSec: number | null;
}

export function ingestSummary(health: HealthResponse | undefined): IngestSummary | null {
  const ingest = health?.checks.ingest;

  if (ingest === undefined) {
    return null;
  }

  if (typeof ingest === 'string') {
    return { degraded: ingest === 'error', lastCandleAgeSec: null };
  }

  return { degraded: ingest.status === 'degraded', lastCandleAgeSec: ingest.lastCandleAgeSec };
}

export function feedTone(
  connection: ConnectionState,
  ingest: IngestSummary | null,
  apiDown: boolean,
): FeedTone {
  if (apiDown) {
    return 'offline';
  }
  if (ingest?.degraded === true) {
    return 'stale';
  }
  if (connection === 'connected') {
    return 'live';
  }
  if (connection === 'connecting') {
    return 'connecting';
  }
  return 'offline';
}

export function formatAge(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds)) {
    return null;
  }
  if (seconds < 60) {
    return `${String(Math.max(0, Math.round(seconds)))} s`;
  }
  if (seconds < 3600) {
    return `${String(Math.floor(seconds / 60))} min`;
  }
  return `${String(Math.floor(seconds / 3600))} h`;
}

export function feedDetail(tone: FeedTone, ingest: IngestSummary | null): string {
  if (tone === 'offline' && ingest === null) {
    return 'El API no responde o el stream de velas esta cerrado.';
  }

  const age = formatAge(ingest?.lastCandleAgeSec ?? null);
  const last = age === null ? 'sin vela reciente' : `ultima vela hace ${age}`;

  if (tone === 'stale') {
    return `Ingesta degradada: ${last}.`;
  }

  return `Stream de velas: ${FEED_LABEL[tone].toLowerCase()}; ${last}.`;
}

export function ConnectionBadge() {
  const health = useHealth();
  const { candleStream } = useLiveStatus();

  const ingest = ingestSummary(health.data);
  const tone = feedTone(candleStream, ingest, health.isError);
  const age = formatAge(ingest?.lastCandleAgeSec ?? null);
  const alarming = tone === 'stale' || tone === 'offline';

  return (
    <p className={styles.badge} title={feedDetail(tone, ingest)}>
      <span className={cx(styles.dot, styles[tone])} aria-hidden="true" />
      <span className={cx(alarming && styles.alarming)}>{FEED_LABEL[tone]}</span>
      {age === null ? null : <span className={styles.age}>{age}</span>}
    </p>
  );
}
