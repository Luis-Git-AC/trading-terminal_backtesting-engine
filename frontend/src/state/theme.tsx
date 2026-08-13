import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export const THEME_PREFERENCES = ['system', 'light', 'dark'] as const;

export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'tt:theme';

const LIGHT_QUERY = '(prefers-color-scheme: light)';

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && THEME_PREFERENCES.some((option) => option === value);
}

export function resolveTheme(preference: ThemePreference, systemLight: boolean): ResolvedTheme {
  if (preference === 'system') {
    return systemLight ? 'light' : 'dark';
  }
  return preference;
}

function lightQuery(): MediaQueryList | null {
  return typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia(LIGHT_QUERY) : null;
}

export function readStoredPreference(): ThemePreference {
  try {
    const stored = globalThis.localStorage?.getItem(THEME_STORAGE_KEY);
    return isThemePreference(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

function storePreference(preference: ThemePreference): void {
  try {
    globalThis.localStorage?.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    return;
  }
}

export function applyTheme(theme: ResolvedTheme): void {
  globalThis.document?.documentElement.setAttribute('data-theme', theme);
}

const initialPreference = readStoredPreference();
const initialSystemLight = lightQuery()?.matches ?? false;

export function initialResolvedTheme(): ResolvedTheme {
  return resolveTheme(initialPreference, initialSystemLight);
}

export interface ThemeControl {
  readonly preference: ThemePreference;
  readonly resolved: ResolvedTheme;
  readonly setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeControl | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(initialPreference);
  const [systemLight, setSystemLight] = useState(initialSystemLight);

  useEffect(() => {
    const query = lightQuery();
    if (query === null) {
      return;
    }
    const onChange = (event: MediaQueryListEvent): void => {
      setSystemLight(event.matches);
    };
    query.addEventListener('change', onChange);
    return () => {
      query.removeEventListener('change', onChange);
    };
  }, []);

  const resolved = resolveTheme(preference, systemLight);

  useEffect(() => {
    applyTheme(resolved);
  }, [resolved]);

  const value = useMemo<ThemeControl>(
    () => ({
      preference,
      resolved,
      setPreference: (next: ThemePreference) => {
        storePreference(next);
        setPreferenceState(next);
      },
    }),
    [preference, resolved],
  );

  return <ThemeContext value={value}>{children}</ThemeContext>;
}

export function useTheme(): ThemeControl {
  const value = useContext(ThemeContext);
  if (value === null) {
    throw new Error('useTheme debe usarse dentro de <ThemeProvider>');
  }
  return value;
}
