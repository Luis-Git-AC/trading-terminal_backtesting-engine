import type { SeriesMarker, UTCTimestamp } from 'lightweight-charts';
import type { BacktestTrade } from '@tt/shared';
import type { ChartTheme } from '@/components/Chart/theme';

export function toChartTime(epochMs: number): UTCTimestamp {
  return Math.floor(epochMs / 1000) as UTCTimestamp;
}

export function tradeOutcomeColor(trade: BacktestTrade, theme: ChartTheme): string {
  return trade.pnlR >= 0 ? theme.up : theme.down;
}

export function entryLabel(trade: BacktestTrade): string {
  return `#${String(trade.seq)} ${trade.side === 'long' ? 'L' : 'S'}`;
}

export function exitLabel(trade: BacktestTrade): string {
  const sign = trade.pnlR >= 0 ? '+' : '';
  return `#${String(trade.seq)} ${sign}${trade.pnlR.toFixed(2)}R ${trade.exitReason}`;
}

export function tradeMarkers(
  trades: readonly BacktestTrade[],
  theme: ChartTheme,
): SeriesMarker<UTCTimestamp>[] {
  const markers = trades.flatMap((trade): SeriesMarker<UTCTimestamp>[] => {
    const color = tradeOutcomeColor(trade, theme);

    return [
      {
        time: toChartTime(trade.entryTs),
        position: trade.side === 'long' ? 'belowBar' : 'aboveBar',
        shape: trade.side === 'long' ? 'arrowUp' : 'arrowDown',
        color: theme.accent,
        text: entryLabel(trade),
      },
      {
        time: toChartTime(trade.exitTs),
        position: trade.side === 'long' ? 'aboveBar' : 'belowBar',
        shape: trade.side === 'long' ? 'arrowDown' : 'arrowUp',
        color,
        text: exitLabel(trade),
      },
    ];
  });

  return markers.sort((a, b) => a.time - b.time);
}

/** Nombre corto de cada tipo de evento; uno desconocido se pinta con su propio tipo. */
export const EVENT_LABELS: Readonly<Record<string, string>> = {
  'fred-release': 'FRED',
  'eia-wpsr': 'EIA',
  'cftc-cot': 'COT',
};

/** Tope de banderitas en pantalla: por encima, los eventos se agrupan por tramo. */
export const MAX_EVENT_MARKERS = 24;

const DETAIL_KEYS = ['releaseName', 'period', 'reportDate'] as const;

function detailOf(payload: Readonly<Record<string, unknown>>): string | null {
  for (const key of DETAIL_KEYS) {
    const value = payload[key];
    if (typeof value === 'string' && value !== '') return value;
    if (typeof value === 'number') return String(value);
  }
  return null;
}

export function eventLabel(event: MarketEventView): string {
  const name = EVENT_LABELS[event.type] ?? event.type;
  const detail = detailOf(event.payload);
  return detail === null ? name : `${name} ${detail}`;
}

/**
 * Tramo con el que se agrupan los eventos: nunca menor que una vela (dos marcas en la misma vela
 * se pisarian) y lo bastante grande para que la ventana visible no pase de `MAX_EVENT_MARKERS`.
 */
export function eventBucketMs(fromMs: number, toMs: number, stepMs: number): number {
  const span = Math.max(toMs - fromMs, stepMs);
  return Math.max(stepMs, Math.ceil(span / MAX_EVENT_MARKERS));
}

export interface MarketEventView {
  readonly scheduledAt: number;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * Una marca por tramo: con un solo evento lleva su tipo y su dato, y con varios el recuento, que
 * es lo que evita pintar doscientas banderitas en una ventana larga.
 */
export function eventMarkers(
  events: readonly MarketEventView[],
  theme: ChartTheme,
  bucketMs: number,
): SeriesMarker<UTCTimestamp>[] {
  const buckets = new Map<number, MarketEventView[]>();

  for (const event of [...events].sort((a, b) => a.scheduledAt - b.scheduledAt)) {
    const bucket = Math.floor(event.scheduledAt / Math.max(bucketMs, 1));
    const group = buckets.get(bucket);
    if (group === undefined) buckets.set(bucket, [event]);
    else group.push(event);
  }

  return [...buckets.values()]
    .flatMap((group): SeriesMarker<UTCTimestamp>[] => {
      const first = group[0];
      if (first === undefined) return [];

      return [
        {
          time: toChartTime(first.scheduledAt),
          position: 'aboveBar',
          shape: 'circle',
          color: theme.event,
          text: group.length === 1 ? eventLabel(first) : `${String(group.length)} eventos`,
        },
      ];
    })
    .sort((a, b) => a.time - b.time);
}
