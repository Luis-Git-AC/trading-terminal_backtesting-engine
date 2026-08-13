import type { RunStatus } from '@tt/shared';

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  queued: 'En cola',
  running: 'Ejecutando',
  completed: 'Completado',
  failed: 'Fallido',
  cancelled: 'Cancelado',
};

export const CANCELLABLE_STATUSES = ['queued', 'running'] as const;

export function isCancellable(status: RunStatus | undefined): boolean {
  return status !== undefined && CANCELLABLE_STATUSES.some((option) => option === status);
}

export function formatPct(pct: number): string {
  return `${pct.toFixed(1)}%`;
}

export function formatEta(etaMs: number | null): string {
  if (etaMs === null) {
    return '—';
  }
  if (etaMs < 1000) {
    return '<1s';
  }

  const totalSeconds = Math.round(etaMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return minutes === 0 ? `${String(seconds)}s` : `${String(minutes)}m ${String(seconds)}s`;
}

export function formatCount(value: number): string {
  return value.toLocaleString('es-ES', { useGrouping: 'always' });
}

export function formatQuote(value: string | undefined): string {
  if (value === undefined) {
    return '—';
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return value;
  }

  return parsed.toLocaleString('es-ES', {
    useGrouping: 'always',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function barsLabel(done: number, total: number | null | undefined): string {
  if (total === null || total === undefined || total === 0) {
    return formatCount(done);
  }
  return `${formatCount(done)} / ${formatCount(total)}`;
}
