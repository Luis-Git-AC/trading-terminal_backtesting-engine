import { useMemo, useState } from 'react';
import type { BacktestTrade } from '@tt/shared';
import {
  SORT_KEYS,
  SORT_LABEL,
  TRADES_PAGE_SIZE,
  nextSort,
  pageCount,
  pageOf,
  sortTrades,
  type SortState,
} from '@/components/Results/trades';
import { cx } from '@/lib/cx';
import styles from './Results.module.css';

export interface TradesTableProps {
  readonly trades: readonly BacktestTrade[];
  readonly selectedSeq?: number | undefined;
  readonly onSelect?: ((trade: BacktestTrade) => void) | undefined;
  readonly pageSize?: number | undefined;
  readonly totalTrades?: number | undefined;
}

function formatInstant(ts: number): string {
  return new Date(ts).toISOString().slice(0, 16).replace('T', ' ');
}

function formatR(value: number): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}`;
}

export function TradesTable({
  trades,
  selectedSeq,
  onSelect,
  pageSize = TRADES_PAGE_SIZE,
  totalTrades,
}: TradesTableProps) {
  const [sort, setSort] = useState<SortState>({ key: 'seq', direction: 'asc' });
  const [page, setPage] = useState(0);

  const sorted = useMemo(() => sortTrades(trades, sort), [trades, sort]);
  const total = pageCount(sorted.length, pageSize);
  const current = Math.min(page, total - 1);
  const visible = useMemo(() => pageOf(sorted, current, pageSize), [sorted, current, pageSize]);

  if (trades.length === 0) {
    return <p className={styles.empty}>El run no cerro ninguna operacion.</p>;
  }

  const truncated = totalTrades !== undefined && totalTrades > trades.length;

  return (
    <div className={styles.tradesWrapper}>
      {truncated && (
        <p className={styles.truncated}>
          Mostrando las {sorted.length} primeras de {totalTrades} operaciones; el API pagina por
          cursor.
        </p>
      )}

      <table className={styles.trades}>
        <thead>
          <tr>
            {SORT_KEYS.map((key) => (
              <th key={key} scope="col">
                <button
                  type="button"
                  className={cx(styles.sortButton, sort.key === key && styles.sortActive)}
                  aria-sort={
                    sort.key === key
                      ? sort.direction === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : 'none'
                  }
                  onClick={() => {
                    setSort((currentSort) => nextSort(currentSort, key));
                    setPage(0);
                  }}
                >
                  {SORT_LABEL[key]}
                  {sort.key === key && (
                    <span aria-hidden="true">{sort.direction === 'asc' ? ' ▲' : ' ▼'}</span>
                  )}
                </button>
              </th>
            ))}
            <th scope="col">Lado</th>
            <th scope="col">Salida</th>
            <th scope="col">Motivo</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((trade) => (
            <tr
              key={trade.seq}
              className={cx(
                styles.tradeRow,
                trade.seq === selectedSeq && styles.tradeRowSelected,
                onSelect !== undefined && styles.tradeRowClickable,
              )}
              {...(onSelect === undefined
                ? {}
                : {
                    onClick: () => {
                      onSelect(trade);
                    },
                    tabIndex: 0,
                    'aria-label': `Centrar el grafico en la operacion ${String(trade.seq)}`,
                    onKeyDown: (event: React.KeyboardEvent) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        onSelect(trade);
                      }
                    },
                  })}
            >
              <td className={styles.numeric}>{trade.seq}</td>
              <td
                className={cx(styles.numeric, trade.pnlR >= 0 ? styles.positive : styles.negative)}
              >
                {formatR(trade.pnlR)}
              </td>
              <td className={styles.numeric}>{formatInstant(trade.entryTs)}</td>
              <td>{trade.side === 'long' ? 'Largo' : 'Corto'}</td>
              <td className={styles.numeric}>{formatInstant(trade.exitTs)}</td>
              <td>{trade.exitReason}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {total > 1 && (
        <nav className={styles.pager} aria-label="Paginacion de operaciones">
          <button
            type="button"
            className={styles.pagerButton}
            disabled={current === 0}
            onClick={() => {
              setPage(current - 1);
            }}
          >
            Anterior
          </button>
          <span className={styles.pagerLabel}>
            {current + 1} / {total} · {sorted.length} operaciones
          </span>
          <button
            type="button"
            className={styles.pagerButton}
            disabled={current >= total - 1}
            onClick={() => {
              setPage(current + 1);
            }}
          >
            Siguiente
          </button>
        </nav>
      )}
    </div>
  );
}
