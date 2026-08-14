import { expect, test } from '@playwright/test';
import { launchBacktest, panel, readMetrics, waitForCompleted } from './support.js';

const SEED = 20260814;

test.describe('flujo 3: reejecutar con la misma semilla da las mismas metricas', () => {
  test('dos runs con la misma semilla pintan metricas identicas en pantalla', async ({ page }) => {
    await page.goto('/');

    const first = await launchBacktest(page, { seed: SEED, label: 'repro A' });
    await waitForCompleted(page);
    const metricsA = await readMetrics(page);

    const second = await launchBacktest(page, { seed: SEED, label: 'repro B' });
    await waitForCompleted(page);
    const metricsB = await readMetrics(page);

    expect(second).not.toBe(first);

    expect(Object.keys(metricsA).length).toBeGreaterThanOrEqual(8);
    expect(Object.values(metricsA).filter((value) => value !== '—').length).toBeGreaterThanOrEqual(
      8,
    );

    expect(metricsB).toEqual(metricsA);
  });

  test('la comparacion no es vacua: cambiar un parametro cambia las metricas', async ({ page }) => {
    await page.goto('/');

    await launchBacktest(page, { seed: SEED, label: 'base' });
    await waitForCompleted(page);
    const base = await readMetrics(page);

    await panel(page, 'Parametros').getByLabel('EMA rapida').fill('5');
    await launchBacktest(page, { seed: SEED, label: 'ema rapida 5' });
    await waitForCompleted(page);
    const changed = await readMetrics(page);

    expect(Object.keys(changed)).toEqual(Object.keys(base));
    expect(changed).not.toEqual(base);
  });
});
