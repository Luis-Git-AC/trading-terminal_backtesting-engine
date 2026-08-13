import { COMPARE_MAX_IDS, type BacktestMetricsResponse, type RunSummary } from '@tt/shared';

export const MAX_COMPARE = COMPARE_MAX_IDS;
export const MIN_COMPARE = 2;

export type Better = 'higher' | 'lower' | null;

export interface CompareMetric {
  readonly key: keyof BacktestMetricsResponse;
  readonly label: string;
  readonly better: Better;
}

export const COMPARE_METRICS: readonly CompareMetric[] = [
  { key: 'netProfit', label: 'Beneficio neto', better: 'higher' },
  { key: 'netProfitPct', label: 'Beneficio neto (%)', better: 'higher' },
  { key: 'maxDrawdown', label: 'Max drawdown', better: 'lower' },
  { key: 'profitFactor', label: 'Profit factor', better: 'higher' },
  { key: 'winRate', label: 'Aciertos', better: 'higher' },
  { key: 'expectancyR', label: 'Esperanza (R)', better: 'higher' },
  { key: 'avgWinR', label: 'Media ganadora (R)', better: 'higher' },
  { key: 'avgLossR', label: 'Media perdedora (R)', better: 'higher' },
  { key: 'largestLossR', label: 'Mayor perdida (R)', better: 'higher' },
  { key: 'trades', label: 'Operaciones', better: null },
  { key: 'exposurePct', label: 'Exposicion', better: null },
];

export function metricNumber(
  metrics: BacktestMetricsResponse | null,
  key: keyof BacktestMetricsResponse,
): number | null {
  if (metrics === null) {
    return null;
  }

  const raw = metrics[key];

  if (raw === null || typeof raw === 'boolean') {
    return null;
  }

  const value = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(value) ? value : null;
}

export function bestIndex(values: readonly (number | null)[], better: Better): number | null {
  if (better === null) {
    return null;
  }

  const present = values
    .map((value, index) => ({ value, index }))
    .filter((entry): entry is { value: number; index: number } => entry.value !== null);

  if (present.length < 2) {
    return null;
  }

  const bestValue = present.reduce(
    (best, entry) =>
      better === 'higher' ? Math.max(best, entry.value) : Math.min(best, entry.value),
    present[0]!.value,
  );

  const winners = present.filter((entry) => entry.value === bestValue);
  return winners.length === 1 ? (winners[0]?.index ?? null) : null;
}

function uniqueValues<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

export function mismatchWarnings(runs: readonly RunSummary[]): string[] {
  if (runs.length < 2) {
    return [];
  }

  const warnings: string[] = [];

  const symbols = uniqueValues(runs.map((run) => run.symbol));
  if (symbols.length > 1) {
    warnings.push(`Simbolos distintos (${symbols.join(', ')}): las cifras no son comparables.`);
  }

  const timeframes = uniqueValues(runs.map((run) => run.timeframe));
  if (timeframes.length > 1) {
    warnings.push(
      `Timeframes distintos (${timeframes.join(', ')}): el numero de barras y de operaciones no es comparable.`,
    );
  }

  const ranges = uniqueValues(runs.map((run) => `${run.range.from}|${run.range.to}`));
  if (ranges.length > 1) {
    warnings.push('Rangos de fechas distintos: cada run ha visto un mercado diferente.');
  }

  const engines = uniqueValues(runs.map((run) => run.engineVersion));
  if (engines.length > 1) {
    warnings.push(
      `Versiones del motor distintas (${engines.join(', ')}): los resultados pueden no ser reproducibles entre si.`,
    );
  }

  return warnings;
}

export function toggleSelection(
  selected: readonly string[],
  runId: string,
  max = MAX_COMPARE,
): string[] {
  if (selected.includes(runId)) {
    return selected.filter((id) => id !== runId);
  }
  if (selected.length >= max) {
    return [...selected];
  }
  return [...selected, runId];
}

export function canCompare(selected: readonly string[]): boolean {
  return selected.length >= MIN_COMPARE && selected.length <= MAX_COMPARE;
}
