import { expect, test } from '@playwright/test';
import { blockApi, panel } from './support.js';

test.describe('flujo 5: con el API caido la app avisa, no se queda en blanco', () => {
  test('la terminal explica el fallo y dice como recuperarse', async ({ page }) => {
    await blockApi(page);
    await page.goto('/');

    await expect(page.getByRole('navigation', { name: 'Secciones' })).toBeVisible();
    await expect(panel(page, 'Grafico')).toBeVisible();
    await expect(panel(page, 'Parametros')).toBeVisible();

    const alerts = page.getByRole('alert');
    await expect(alerts.first()).toBeVisible();

    await expect(alerts.first()).toContainText('No se ha podido contactar con el API.');
    await expect(alerts.first()).toContainText('npm run dev:api');
    await expect(alerts.first().getByRole('button', { name: 'Reintentar' })).toBeVisible();
  });

  test('la cabecera marca la conexion como caida', async ({ page }) => {
    await blockApi(page);
    await page.goto('/');

    await expect(page.getByRole('banner').getByText('Sin conexion')).toBeVisible();
    await expect(page.getByRole('banner').getByText('En vivo')).toHaveCount(0);
  });

  test('el historial de runs tambien avisa en vez de quedarse vacio', async ({ page }) => {
    await blockApi(page);
    await page.goto('/runs');

    const alert = panel(page, 'Historial de runs').getByRole('alert');
    await expect(alert).toContainText('No se ha podido cargar el historial');
    await expect(alert.getByRole('button', { name: 'Reintentar' })).toBeVisible();
  });

  test('al volver el API, «Reintentar» recupera la vista sin recargar', async ({ page }) => {
    let down = true;
    await blockApi(page, () => down);

    await page.goto('/');

    const chart = panel(page, 'Grafico');
    await expect(chart.getByRole('alert')).toContainText('No se ha podido contactar con el API.');

    down = false;
    await chart.getByRole('alert').getByRole('button', { name: 'Reintentar' }).click();

    await expect(chart.getByText('BTCUSDT · 15m · 500/500')).toBeVisible();
    await expect(chart.getByRole('alert')).toHaveCount(0);
    await expect(chart.locator('canvas').first()).toBeVisible();
  });
});
