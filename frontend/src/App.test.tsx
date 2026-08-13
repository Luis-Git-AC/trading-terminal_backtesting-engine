import { StrictMode } from 'react';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@/App';
import { DEFAULT_SYMBOL, DEFAULT_TIMEFRAME, FALLBACK_SYMBOLS } from '@/state/market-selection';

const consoleCalls: unknown[][] = [];

function renderAt(path: string) {
  return render(
    <StrictMode>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </StrictMode>,
  );
}

describe('App', () => {
  beforeEach(() => {
    consoleCalls.length = 0;
    const record = (...args: unknown[]) => {
      consoleCalls.push(args);
    };
    vi.spyOn(console, 'error').mockImplementation(record);
    vi.spyOn(console, 'warn').mockImplementation(record);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    expect(consoleCalls).toEqual([]);
  });

  it('pinta la cabecera con marca, navegacion y estado de conexion', () => {
    renderAt('/');

    const header = screen.getByRole('banner');
    expect(within(header).getByText('Trading Terminal')).toBeDefined();
    expect(within(header).getByRole('link', { name: 'Terminal' })).toBeDefined();
    expect(within(header).getByRole('link', { name: 'Runs' })).toBeDefined();
    expect(within(header).getByText('Sin conexion')).toBeDefined();
  });

  it('ofrece el selector de simbolo y el de timeframe con los valores por defecto', () => {
    renderAt('/');

    const symbol = screen.getByRole('combobox', { name: /simbolo/i });
    expect(symbol).toHaveProperty('value', DEFAULT_SYMBOL);
    expect(within(symbol).getAllByRole('option')).toHaveLength(FALLBACK_SYMBOLS.length);

    const active = screen.getByRole('button', { name: DEFAULT_TIMEFRAME });
    expect(active.getAttribute('aria-pressed')).toBe('true');
  });

  it('la ruta raiz muestra las tres zonas de la terminal', () => {
    renderAt('/');

    expect(screen.getByRole('heading', { name: 'Parametros' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Grafico' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Resultados' })).toBeDefined();
  });

  it('la ruta /runs muestra el historial y no la terminal', () => {
    renderAt('/runs');

    expect(screen.getByRole('heading', { name: 'Historial de runs' })).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'Parametros' })).toBeNull();
  });

  it('declara que por debajo de 960 px no hay soporte', () => {
    renderAt('/');

    expect(screen.getByText(/no se da\s+soporte/i)).toBeDefined();
  });

  it('monta las dos rutas seguidas sin ensuciar la consola', () => {
    renderAt('/');
    renderAt('/runs');

    expect(consoleCalls).toEqual([]);
  });
});
