import { NavLink } from 'react-router';
import type { ConnectionState } from '@/hooks/useEventSource';
import { cx } from '@/lib/cx';
import { useMarketSelection } from '@/state/market-selection';
import styles from './AppHeader.module.css';

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connected: 'En vivo',
  connecting: 'Conectando',
  disconnected: 'Sin conexion',
};

export function AppHeader({
  connection = 'disconnected',
}: {
  connection?: ConnectionState | undefined;
}) {
  const { symbol, symbols, timeframe, timeframes, setSymbol, setTimeframe } = useMarketSelection();

  return (
    <header className={styles.header}>
      <div className={styles.brand}>
        <span className={styles.mark} aria-hidden="true">
          TT
        </span>
        <span className={styles.wordmark}>Trading Terminal</span>
      </div>

      <nav className={styles.nav} aria-label="Secciones">
        <NavLink
          to="/"
          end
          className={({ isActive }) => cx(styles.navLink, isActive && styles.navLinkActive)}
        >
          Terminal
        </NavLink>
        <NavLink
          to="/runs"
          className={({ isActive }) => cx(styles.navLink, isActive && styles.navLinkActive)}
        >
          Runs
        </NavLink>
      </nav>

      <div className={styles.market}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Simbolo</span>
          <select
            className={styles.select}
            value={symbol}
            onChange={(event) => {
              setSymbol(event.target.value);
            }}
          >
            {symbols.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        <div className={styles.field}>
          <span className={styles.fieldLabel} id="tf-label">
            Timeframe
          </span>
          <div className={styles.segmented} role="group" aria-labelledby="tf-label">
            {timeframes.map((option) => (
              <button
                key={option}
                type="button"
                className={cx(styles.segment, option === timeframe && styles.segmentActive)}
                aria-pressed={option === timeframe}
                onClick={() => {
                  setTimeframe(option);
                }}
              >
                {option}
              </button>
            ))}
          </div>
        </div>
      </div>

      <p className={styles.connection}>
        <span className={cx(styles.dot, styles[connection])} aria-hidden="true" />
        {CONNECTION_LABEL[connection]}
      </p>
    </header>
  );
}
