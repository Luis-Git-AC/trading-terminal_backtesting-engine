import { expect, test } from '@playwright/test';
import { panel } from './support.js';

test.describe('flujo 1: cargar la app y ver el grafico con velas', () => {
  test('la terminal pinta las velas reales del fixture', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('navigation', { name: 'Secciones' })).toBeVisible();

    const chart = panel(page, 'Grafico');

    await expect(chart.getByText('BTCUSDT · 15m · 500/500')).toBeVisible();
    await expect(chart.locator('canvas').first()).toBeVisible();

    await expect(chart.getByRole('alert')).toHaveCount(0);
    await expect(chart.getByText(/Aun no hay datos/)).toHaveCount(0);
  });

  test('el panel de parametros declara la cobertura real del fixture', async ({ page }) => {
    await page.goto('/');

    await expect(panel(page, 'Parametros').getByText(/^Cobertura:/)).toContainText(
      'Cobertura: 2026-07-01 a 2026-07-21 · 2000 velas',
    );
  });

  test('cambiar de timeframe recarga el grafico con la otra serie', async ({ page }) => {
    await page.goto('/');
    await expect(panel(page, 'Grafico').getByText('BTCUSDT · 15m · 500/500')).toBeVisible();

    await page
      .getByRole('group', { name: 'Timeframe' })
      .getByRole('button', { name: '1m' })
      .click();

    await expect(panel(page, 'Grafico').getByText('BTCUSDT · 1m · 500/500')).toBeVisible();
    await expect(panel(page, 'Grafico').locator('canvas').first()).toBeVisible();
  });
});
