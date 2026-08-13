import type { BacktestTrade } from '@tt/shared';

export const TRADES_PAGE_SIZE = 50;

export const SORT_KEYS = ['seq', 'pnlR', 'entryTs'] as const;

export type SortKey = (typeof SORT_KEYS)[number];

export type SortDirection = 'asc' | 'desc';

export interface SortState {
  readonly key: SortKey;
  readonly direction: SortDirection;
}

export const SORT_LABEL: Record<SortKey, string> = {
  seq: '#',
  pnlR: 'PnL (R)',
  entryTs: 'Entrada',
};

export function nextSort(current: SortState, key: SortKey): SortState {
  if (current.key !== key) {
    return { key, direction: key === 'seq' ? 'asc' : 'desc' };
  }
  return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' };
}

export function sortTrades(
  trades: readonly BacktestTrade[],
  sort: SortState,
): readonly BacktestTrade[] {
  const factor = sort.direction === 'asc' ? 1 : -1;

  return [...trades].sort((a, b) => {
    const delta = a[sort.key] - b[sort.key];
    return delta === 0 ? a.seq - b.seq : delta * factor;
  });
}

export function pageCount(total: number, pageSize = TRADES_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

export function pageOf<T>(items: readonly T[], page: number, pageSize = TRADES_PAGE_SIZE): T[] {
  const clamped = Math.min(Math.max(0, page), pageCount(items.length, pageSize) - 1);
  return items.slice(clamped * pageSize, clamped * pageSize + pageSize);
}

export function tradeRange(trade: BacktestTrade, padMs: number): { from: number; to: number } {
  return { from: trade.entryTs - padMs, to: trade.exitTs + padMs };
}
