import { expect, test } from '@playwright/test';
import { launchBacktest, panel, waitForCompleted } from './support.js';

test.describe('flujo 4: comparar dos runs, tabla y curvas', () => {
  test('marcar dos runs del historial pinta la tabla comparativa y las curvas', async ({
    page,
  }) => {
    await page.goto('/');

    await launchBacktest(page, { seed: 11, label: 'comparado A' });
    await waitForCompleted(page);

    await panel(page, 'Parametros').getByLabel('EMA rapida').fill('5');
    await launchBacktest(page, { seed: 22, label: 'comparado B' });
    await waitForCompleted(page);

    await page.getByRole('link', { name: 'Runs' }).click();

    const history = panel(page, 'Historial de runs');
    await expect(history.getByRole('table')).toBeVisible();

    const comparador = panel(page, 'Comparador');
    await expect(comparador.getByText('Nada que comparar todavia')).toBeVisible();

    await history.getByRole('checkbox').nth(0).check();
    await history.getByRole('checkbox').nth(1).check();

    await expect(comparador.getByText('2/4 seleccionados')).toBeVisible();

    await expect(comparador.getByRole('columnheader', { name: /comparado A/ })).toBeVisible();
    await expect(comparador.getByRole('columnheader', { name: /comparado B/ })).toBeVisible();

    const beneficio = comparador.getByRole('row').filter({
      has: page.getByRole('rowheader', { name: 'Beneficio neto', exact: true }),
    });
    await expect(beneficio.getByRole('cell')).toHaveCount(2);
    await expect(beneficio.locator('[data-best="true"]')).toHaveCount(1);

    await expect(comparador.locator('[data-testid="compare-curves"] svg').first()).toBeVisible();
    await expect(comparador.locator('.recharts-line')).toHaveCount(2);
  });

  test('un solo run seleccionado no compara nada', async ({ page }) => {
    await page.goto('/');
    await launchBacktest(page, { seed: 33 });
    await waitForCompleted(page);

    await page.getByRole('link', { name: 'Runs' }).click();

    const comparador = panel(page, 'Comparador');
    await panel(page, 'Historial de runs').getByRole('checkbox').first().check();

    await expect(comparador.getByText('1/4 seleccionados')).toBeVisible();
    await expect(comparador.getByText('Nada que comparar todavia')).toBeVisible();
  });
});
