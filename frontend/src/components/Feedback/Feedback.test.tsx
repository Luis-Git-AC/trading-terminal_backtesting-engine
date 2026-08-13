import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, recoveryHintFor } from '@/api/errors';
import { EmptyState } from '@/components/Feedback/EmptyState';
import { ErrorState } from '@/components/Feedback/ErrorState';
import { Skeleton } from '@/components/Feedback/Skeleton';

describe('EmptyState', () => {
  it('pinta el titulo, la instruccion y el comando que hay que ejecutar', () => {
    render(
      <EmptyState
        title="Aun no hay datos para 15m"
        hint="Rellena el historico y vuelve."
        command="npm run backfill -- --symbol BTCUSDT --timeframe 15m"
      />,
    );

    const state = screen.getByRole('status');
    expect(state.textContent).toContain('Aun no hay datos para 15m');
    expect(state.textContent).toContain('Rellena el historico y vuelve.');
    expect(state.textContent).toContain('npm run backfill -- --symbol BTCUSDT --timeframe 15m');
  });

  it('sin instruccion ni comando solo pinta el titulo', () => {
    render(<EmptyState title="Nada que ver" />);

    expect(screen.getByRole('status').textContent).toBe('Nada que ver');
  });

  it('el action se renderiza dentro del estado y es pulsable', () => {
    const onClick = vi.fn();
    render(
      <EmptyState
        title="Sin runs"
        action={
          <button type="button" onClick={onClick}>
            Ir a la terminal
          </button>
        }
      />,
    );

    screen.getByRole('button', { name: 'Ir a la terminal' }).click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('ErrorState', () => {
  it('un fallo de red se anuncia como alerta con instruccion accionable y su codigo', () => {
    render(<ErrorState error={ApiError.network(new TypeError('fetch failed'))} />);

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('No se ha podido contactar con el API.');
    expect(alert.textContent).toContain('npm run dev:api');
    expect(alert.textContent).toContain('NETWORK_ERROR');
  });

  it('el mensaje del servidor gana al texto por defecto del codigo', () => {
    render(
      <ErrorState error={new ApiError('NOT_FOUND', 'No existe el run 42', { status: 404 })} />,
    );

    expect(screen.getByRole('alert').textContent).toContain('No existe el run 42');
  });

  it('un error que no es del API se describe sin inventar codigo', () => {
    render(<ErrorState error={new Error('algo raro')} />);

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('algo raro');
    expect(alert.textContent).not.toContain('NETWORK_ERROR');
  });

  it('sin onRetry no hay boton de reintentar', () => {
    render(<ErrorState error={ApiError.network(new Error('x'))} />);

    expect(screen.queryByRole('button')).toBeNull();
  });

  it('con onRetry el boton reintenta y se bloquea mientras reintenta', () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <ErrorState error={ApiError.network(new Error('x'))} onRetry={onRetry} />,
    );

    const button = screen.getByRole('button', { name: 'Reintentar' });
    button.click();
    expect(onRetry).toHaveBeenCalledTimes(1);

    rerender(<ErrorState error={ApiError.network(new Error('x'))} onRetry={onRetry} retrying />);
    expect(screen.getByRole('button', { name: 'Reintentando…' })).toHaveProperty('disabled', true);
  });
});

describe('recoveryHintFor', () => {
  it('cada codigo del cliente tiene una instruccion concreta, no un texto generico', () => {
    const codes = [
      'VALIDATION_ERROR',
      'NOT_FOUND',
      'CONFLICT',
      'RANGE_TOO_LARGE',
      'UPSTREAM_UNAVAILABLE',
      'INTERNAL',
      'NETWORK_ERROR',
      'MALFORMED_RESPONSE',
    ] as const;

    const hints = codes.map((code) => recoveryHintFor(new ApiError(code, '')));

    expect(hints.filter((hint) => hint === null)).toEqual([]);
    expect(new Set(hints).size).toBe(codes.length);
  });

  it('lo que no es un ApiError no recibe instruccion', () => {
    expect(recoveryHintFor(new Error('boom'))).toBeNull();
    expect(recoveryHintFor(undefined)).toBeNull();
  });
});

describe('Skeleton', () => {
  it('se anuncia como ocupado con la etiqueta de lo que carga', () => {
    render(<Skeleton label="Cargando velas…" />);

    const status = screen.getByRole('status', { name: 'Cargando velas…' });
    expect(status.getAttribute('aria-busy')).toBe('true');
  });

  it('pinta tantas barras como lineas se le pidan, y nunca menos de una', () => {
    const { rerender } = render(<Skeleton label="x" lines={5} />);
    expect(screen.getByRole('status').childElementCount).toBe(5);

    rerender(<Skeleton label="x" lines={0} />);
    expect(screen.getByRole('status').childElementCount).toBe(1);
  });

  it('no filtra texto visible que se confunda con contenido real', () => {
    render(<Skeleton label="Cargando runs…" lines={3} />);

    expect(screen.getByRole('status').textContent).toBe('');
  });
});
