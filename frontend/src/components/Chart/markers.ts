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
