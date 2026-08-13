import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '@/components/ErrorBoundary/ErrorBoundary';

function Boom({ explode }: { explode: boolean }) {
  if (explode) {
    throw new Error('el render ha reventado');
  }
  return <p>contenido vivo</p>;
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sin error deja pasar a los hijos tal cual', () => {
    render(
      <ErrorBoundary>
        <Boom explode={false} />
      </ErrorBoundary>,
    );

    expect(screen.getByText('contenido vivo')).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('un error de render se convierte en alerta con el mensaje, no en pantalla en blanco', () => {
    render(
      <ErrorBoundary>
        <Boom explode />
      </ErrorBoundary>,
    );

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('La interfaz ha fallado');
    expect(alert.textContent).toContain('el render ha reventado');
    expect(screen.queryByText('contenido vivo')).toBeNull();
  });

  it('avisa por onError con el error que ha capturado', () => {
    const onError = vi.fn();

    render(
      <ErrorBoundary onError={onError}>
        <Boom explode />
      </ErrorBoundary>,
    );

    expect(onError).toHaveBeenCalled();
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect((onError.mock.calls[0]?.[0] as Error).message).toBe('el render ha reventado');
  });

  it('«Recargar la terminal» delega en onReload cuando se le pasa', () => {
    const onReload = vi.fn();

    render(
      <ErrorBoundary onReload={onReload}>
        <Boom explode />
      </ErrorBoundary>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Recargar la terminal' }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('«Reintentar sin recargar» vuelve a montar los hijos si ya no fallan', () => {
    let fails = true;

    function Flaky() {
      return <Boom explode={fails} />;
    }

    const { rerender } = render(
      <ErrorBoundary>
        <Flaky />
      </ErrorBoundary>,
    );

    expect(screen.getByRole('alert')).toBeDefined();

    fails = false;
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar sin recargar' }));
    rerender(
      <ErrorBoundary>
        <Flaky />
      </ErrorBoundary>,
    );

    expect(screen.getByText('contenido vivo')).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
