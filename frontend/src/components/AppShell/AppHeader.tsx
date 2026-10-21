import { NavLink } from 'react-router';
import { BrandMark } from '@/components/AppShell/BrandMark';
import { ThemeIcon } from '@/components/AppShell/ThemeIcon';
import { ConnectionBadge } from '@/components/ConnectionBadge/ConnectionBadge';
import { LiveTicker } from '@/components/LiveTicker/LiveTicker';
import { cx } from '@/lib/cx';
import { useMarketSelection } from '@/state/market-selection';
import { THEME_PREFERENCES, useTheme, type ThemePreference } from '@/state/theme';
import styles from './AppHeader.module.css';

const THEME_LABEL: Record<ThemePreference, string> = {
  system: 'Sistema',
  light: 'Claro',
  dark: 'Oscuro',
};

function ThemeToggle() {
  const { preference, setPreference } = useTheme();

  return (
    <div className={styles.field}>
      <span className={styles.fieldLabel} id="theme-label">
        Tema
      </span>
      <div
        className={styles.segmented}
        role="group"
        aria-labelledby="theme-label"
        style={{
          '--segment-count': THEME_PREFERENCES.length,
          '--segment-index': THEME_PREFERENCES.indexOf(preference),
        }}
      >
        {THEME_PREFERENCES.map((option) => (
          <button
            key={option}
            type="button"
            className={cx(styles.segment, option === preference && styles.segmentActive)}
            aria-pressed={option === preference}
            title={THEME_LABEL[option]}
            aria-label={THEME_LABEL[option]}
            onClick={() => {
              setPreference(option);
            }}
          >
            <ThemeIcon preference={option} />
          </button>
        ))}
      </div>
    </div>
  );
}

export function AppHeader() {
  const { symbol, symbols, timeframe, timeframes, setSymbol, setTimeframe } = useMarketSelection();

  return (
    <header className={styles.header}>
      <div className={styles.brand}>
        <BrandMark />
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

      <LiveTicker />

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
          <div
            className={styles.segmented}
            role="group"
            aria-labelledby="tf-label"
            style={{
              '--segment-count': timeframes.length,
              '--segment-index': timeframes.indexOf(timeframe),
            }}
          >
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

        <ThemeToggle />
      </div>

      <ConnectionBadge />
    </header>
  );
}
