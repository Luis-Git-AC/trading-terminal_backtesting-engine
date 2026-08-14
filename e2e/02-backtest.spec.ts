import { expect, test } from '@playwright/test';
import { launchBacktest, metricsSection, panel, progress, waitForCompleted } from './support.js';

test.describe('flujo 2: configurar, lanzar, ver progreso por SSE y metricas', () => {
  test('un backtest de ema-cross llega de la cola al panel de metricas', async ({ page }) => {
    await page.goto('/');
    await expect(panel(page, 'Grafico').getByText('BTCUSDT · 15m · 500/500')).toBeVisible();

    await expect(progress(page)).toHaveCount(0);
    await expect(page.getByText('Ningun run seleccionado')).toBeVisible();

    const stream = page.waitForResponse(
      (response) =>
        /\/api\/backtests\/.+\/stream/.test(response.url()) && response.status() === 200,
    );

    const runId = await launchBacktest(page, { seed: 4242, label: 'e2e flujo 2' });

    expect((await stream).headers()['content-type']).toContain('text/event-stream');

    await expect(progress(page)).toBeVisible();
    await expect(progress(page).getByText(runId)).toBeVisible();

    await waitForCompleted(page);

    await expect(progress(page).getByRole('progressbar')).toHaveCount(0);
    await expect(progress(page)).toContainText('ETA—');
    await expect(progress(page).getByRole('button', { name: 'Cancelar' })).toHaveCount(0);
    await expect(progress(page).getByRole('button', { name: 'Cerrar' })).toBeVisible();

    const metrics = metricsSection(page);
    await expect(metrics).toBeVisible();
    await expect(metrics.getByText('Beneficio neto', { exact: true })).toBeVisible();
    await expect(metrics.locator('dd').first()).not.toHaveText('—');

    const operaciones = metrics
      .locator('div')
      .filter({ has: page.getByText('Operaciones', { exact: true }) });
    await expect(operaciones.locator('dd')).toHaveText('71');
    await expect(metrics.getByText('Barras', { exact: true })).toBeVisible();

    await expect(page.getByRole('heading', { level: 3, name: 'Equity y drawdown' })).toBeVisible();

    const trades = page
      .getByRole('heading', { level: 3, name: 'Operaciones', exact: true })
      .locator('xpath=ancestor::section[1]');
    await expect(trades.getByRole('table')).toBeVisible();
    await expect(trades.getByRole('row')).toHaveCount(51);
    await expect(trades.getByRole('button', { name: 'Siguiente' })).toBeEnabled();
  });

  test('el run sobrevive a recargar la pagina porque vive en la query string', async ({ page }) => {
    await page.goto('/');
    const runId = await launchBacktest(page, { seed: 99 });
    await waitForCompleted(page);

    await page.reload();

    await expect(progress(page).getByText(runId)).toBeVisible();
    await expect(progress(page).getByText('Completado', { exact: true })).toBeVisible();
    await expect(metricsSection(page)).toBeVisible();
  });

  test('el formulario bloquea «Ejecutar» con un parametro fuera de rango', async ({ page }) => {
    await page.goto('/');
    const params = panel(page, 'Parametros');

    await expect(params.getByLabel('Estrategia')).toBeEnabled();
    await params.getByLabel('EMA rapida').fill('0');

    await expect(params.getByRole('button', { name: 'Ejecutar backtest' })).toBeDisabled();
    await expect(params.getByRole('status')).toBeVisible();
  });
});
