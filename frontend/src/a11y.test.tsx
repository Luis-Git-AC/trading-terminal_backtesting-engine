import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App } from '@/App';
import * as fixtures from '@/test/msw/fixtures';
import { silentQueryClient } from '@/test/query-wrapper';

vi.mock('lightweight-charts', () => import('@/test/fake-lightweight-charts'));

function renderAt(path: string) {
  return render(
    <QueryClientProvider client={silentQueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function violationsIn(container: HTMLElement): Promise<string[]> {
  const results = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false } },
  });

  return results.violations.map(
    (violation) =>
      `${violation.id} (${violation.impact ?? 'sin impacto'}): ${violation.nodes
        .map((node) => node.target.join(' '))
        .join(', ')}`,
  );
}

describe('accesibilidad de la vista principal', () => {
  it('la terminal no tiene violaciones de axe', async () => {
    const { container } = renderAt('/');

    await waitFor(() => {
      expect(screen.getByLabelText('EMA rapida')).toBeDefined();
    });

    expect(await violationsIn(container)).toEqual([]);
  });

  it('el historial y el comparador no tienen violaciones de axe', async () => {
    const { container } = renderAt('/runs');

    await waitFor(() => {
      expect(screen.getByLabelText(`Comparar el run ${fixtures.RUN_ID}`)).toBeDefined();
    });

    expect(await violationsIn(container)).toEqual([]);
  });

  it('el panel de resultados con metricas y operaciones tampoco', async () => {
    const { container } = renderAt(`/?run=${fixtures.RUN_ID}`);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Operaciones' })).toBeDefined();
    });

    expect(await violationsIn(container)).toEqual([]);
  });

  it('el orden de la tabla de operaciones se anuncia en la cabecera, no en su boton', async () => {
    renderAt(`/?run=${fixtures.RUN_ID}`);

    const header = await screen.findByRole('columnheader', { name: /^#/ });

    expect(header.getAttribute('aria-sort')).toBe('ascending');
    expect(within(header).getByRole('button').getAttribute('aria-sort')).toBeNull();
  });
});

describe('navegacion por teclado del panel de parametros', () => {
  it('el tabulador recorre todos los campos en orden y llega al boton de lanzar', async () => {
    const user = userEvent.setup();
    renderAt('/');

    await waitFor(() => {
      expect(screen.getByLabelText('EMA rapida')).toBeDefined();
    });

    const form = screen.getByRole('button', { name: /ejecutar backtest/i }).closest('form');
    expect(form).not.toBeNull();

    const expected = [...(form?.querySelectorAll<HTMLElement>('input, select, button') ?? [])];
    expect(expected.length).toBeGreaterThan(8);

    const first = expected[0];
    expect(first).toBeDefined();
    first?.focus();

    const walked: (Element | null)[] = [document.activeElement];
    for (let step = 1; step < expected.length; step += 1) {
      await user.tab();
      walked.push(document.activeElement);
    }

    expect(walked).toEqual(expected);
    expect(walked.at(-1)).toBe(screen.getByRole('button', { name: /ejecutar backtest/i }));
  });

  it('ningun control del formulario se salta del orden natural con tabindex', async () => {
    renderAt('/');

    await waitFor(() => {
      expect(screen.getByLabelText('EMA rapida')).toBeDefined();
    });

    const form = screen.getByRole('button', { name: /ejecutar backtest/i }).closest('form');
    const offenders = [...(form?.querySelectorAll('[tabindex]') ?? [])].map((node) =>
      node.getAttribute('tabindex'),
    );

    expect(offenders).toEqual([]);
  });

  it('un campo invalido apunta a su mensaje de error, no solo lo pinta al lado', async () => {
    renderAt('/');

    await waitFor(() => {
      expect(screen.getByLabelText('EMA rapida')).toBeDefined();
    });

    fireEvent.change(screen.getByLabelText('EMA rapida'), { target: { value: '999' } });
    fireEvent.change(screen.getByLabelText('Capital inicial'), { target: { value: '0' } });

    for (const label of ['EMA rapida', 'Capital inicial']) {
      const field = screen.getByLabelText(label);
      expect(field.getAttribute('aria-invalid')).toBe('true');

      const describedBy = field.getAttribute('aria-describedby');
      expect(describedBy).not.toBeNull();
      expect(document.getElementById(describedBy ?? '')?.textContent ?? '').not.toBe('');
    }
  });

  it('un formulario valido no deja aria-describedby colgando de ningun id inexistente', async () => {
    const { container } = renderAt('/');

    await waitFor(() => {
      expect(screen.getByLabelText('EMA rapida')).toBeDefined();
    });

    const dangling = [...container.querySelectorAll('[aria-describedby]')]
      .flatMap((node) => (node.getAttribute('aria-describedby') ?? '').split(/\s+/))
      .filter((id) => id !== '' && document.getElementById(id) === null);

    expect(dangling).toEqual([]);
  });
});
