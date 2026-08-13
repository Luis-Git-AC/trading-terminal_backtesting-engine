import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  THEME_STORAGE_KEY,
  ThemeProvider,
  isThemePreference,
  resolveTheme,
  useTheme,
} from '@/state/theme';

function Probe() {
  const { preference, resolved, setPreference } = useTheme();
  return (
    <div>
      <span data-testid="preference">{preference}</span>
      <span data-testid="resolved">{resolved}</span>
      <button
        type="button"
        onClick={() => {
          setPreference('light');
        }}
      >
        claro
      </button>
      <button
        type="button"
        onClick={() => {
          setPreference('dark');
        }}
      >
        oscuro
      </button>
    </div>
  );
}

beforeEach(() => {
  globalThis.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

describe('resolveTheme', () => {
  it('con preferencia explicita ignora la del sistema', () => {
    expect(resolveTheme('light', false)).toBe('light');
    expect(resolveTheme('dark', true)).toBe('dark');
  });

  it('con "system" sigue a la del sistema', () => {
    expect(resolveTheme('system', true)).toBe('light');
    expect(resolveTheme('system', false)).toBe('dark');
  });
});

describe('isThemePreference', () => {
  it('acepta las tres preferencias y rechaza el resto', () => {
    expect(isThemePreference('system')).toBe(true);
    expect(isThemePreference('light')).toBe(true);
    expect(isThemePreference('dark')).toBe(true);
    expect(isThemePreference('sepia')).toBe(false);
    expect(isThemePreference(null)).toBe(false);
  });
});

describe('ThemeProvider', () => {
  it('escribe el tema resuelto en data-theme del documento', () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('cambiar a claro actualiza el atributo y persiste la eleccion', () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );

    act(() => {
      screen.getByRole('button', { name: 'claro' }).click();
    });

    expect(screen.getByTestId('preference').textContent).toBe('light');
    expect(screen.getByTestId('resolved').textContent).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(globalThis.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });

  it('volver a oscuro deshace el cambio', () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );

    act(() => {
      screen.getByRole('button', { name: 'claro' }).click();
    });
    act(() => {
      screen.getByRole('button', { name: 'oscuro' }).click();
    });

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(globalThis.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });
});
