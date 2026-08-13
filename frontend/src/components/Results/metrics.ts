import type { BacktestMetricsResponse } from '@tt/shared';

export const EMPTY_VALUE = '—';

export type MetricTone = 'neutral' | 'signed' | 'inverse';

export interface MetricCard {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly tone: MetricTone;
  readonly sign: number;
  readonly hint: string | undefined;
}

function quote(raw: string): string {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return raw;
  }
  return parsed.toLocaleString('es-ES', {
    useGrouping: 'always',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function ratio(value: number, digits = 2): string {
  return value.toLocaleString('es-ES', {
    useGrouping: 'always',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function percent(value: number, digits = 2): string {
  return `${ratio(value, digits)}%`;
}

function count(value: number): string {
  return value.toLocaleString('es-ES', { useGrouping: 'always' });
}

export function signOf(raw: string | number | null): number {
  if (raw === null) {
    return 0;
  }
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(parsed) || parsed === 0) {
    return 0;
  }
  return parsed > 0 ? 1 : -1;
}

export function nullHint(key: string, metrics: BacktestMetricsResponse): string {
  if (metrics.trades === 0) {
    return 'El run no cerro ninguna operacion.';
  }
  if (key === 'profitFactor') {
    return 'No hubo operaciones perdedoras, asi que el cociente no esta definido.';
  }
  if (key === 'avgLossR' || key === 'largestLossR') {
    return 'No hubo operaciones perdedoras.';
  }
  if (key === 'avgWinR' || key === 'largestWinR') {
    return 'No hubo operaciones ganadoras.';
  }
  return 'El API devolvio null para esta metrica.';
}

function card(
  key: string,
  label: string,
  value: string | null,
  tone: MetricTone,
  sign: number,
  metrics: BacktestMetricsResponse,
): MetricCard {
  return {
    key,
    label,
    value: value ?? EMPTY_VALUE,
    tone,
    sign: value === null ? 0 : sign,
    hint: value === null ? nullHint(key, metrics) : undefined,
  };
}

export function metricCards(metrics: BacktestMetricsResponse): MetricCard[] {
  return [
    card(
      'netProfit',
      'Beneficio neto',
      quote(metrics.netProfit),
      'signed',
      signOf(metrics.netProfit),
      metrics,
    ),
    card(
      'netProfitPct',
      'Beneficio neto (%)',
      percent(metrics.netProfitPct),
      'signed',
      signOf(metrics.netProfitPct),
      metrics,
    ),
    card(
      'maxDrawdown',
      'Max drawdown',
      percent(metrics.maxDrawdown * 100),
      'inverse',
      signOf(metrics.maxDrawdown),
      metrics,
    ),
    card(
      'maxDrawdownQuote',
      'Max drawdown (importe)',
      quote(metrics.maxDrawdownQuote),
      'inverse',
      signOf(metrics.maxDrawdownQuote),
      metrics,
    ),
    card(
      'winRate',
      'Aciertos',
      metrics.winRate === null ? null : percent(metrics.winRate * 100, 1),
      'neutral',
      0,
      metrics,
    ),
    card(
      'profitFactor',
      'Profit factor',
      metrics.profitFactor === null ? null : ratio(metrics.profitFactor),
      'signed',
      metrics.profitFactor === null ? 0 : signOf(metrics.profitFactor - 1),
      metrics,
    ),
    card(
      'expectancyR',
      'Esperanza (R)',
      metrics.expectancyR === null ? null : ratio(metrics.expectancyR),
      'signed',
      signOf(metrics.expectancyR),
      metrics,
    ),
    card('trades', 'Operaciones', count(metrics.trades), 'neutral', 0, metrics),
    card('wins', 'Ganadoras', count(metrics.wins), 'neutral', 0, metrics),
    card('losses', 'Perdedoras', count(metrics.losses), 'neutral', 0, metrics),
    card(
      'avgWinR',
      'Media ganadora (R)',
      metrics.avgWinR === null ? null : ratio(metrics.avgWinR),
      'signed',
      signOf(metrics.avgWinR),
      metrics,
    ),
    card(
      'avgLossR',
      'Media perdedora (R)',
      metrics.avgLossR === null ? null : ratio(metrics.avgLossR),
      'signed',
      signOf(metrics.avgLossR),
      metrics,
    ),
    card(
      'largestWinR',
      'Mayor ganancia (R)',
      metrics.largestWinR === null ? null : ratio(metrics.largestWinR),
      'signed',
      signOf(metrics.largestWinR),
      metrics,
    ),
    card(
      'largestLossR',
      'Mayor perdida (R)',
      metrics.largestLossR === null ? null : ratio(metrics.largestLossR),
      'signed',
      signOf(metrics.largestLossR),
      metrics,
    ),
    card('exposurePct', 'Exposicion', percent(metrics.exposurePct), 'neutral', 0, metrics),
    card('barsTotal', 'Barras', count(metrics.barsTotal), 'neutral', 0, metrics),
  ];
}
