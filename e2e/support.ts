import { expect, type Locator, type Page } from '@playwright/test';
import { z } from 'zod';

export const RUN_ID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

export function panel(page: Page, title: string): Locator {
  return page.locator('section').filter({
    has: page.getByRole('heading', { level: 2, name: title, exact: true }),
  });
}

export function progress(page: Page): Locator {
  return page.getByRole('region', { name: 'Progreso del backtest' });
}

export function metricsSection(page: Page): Locator {
  return page
    .getByRole('heading', { level: 3, name: 'Metricas', exact: true })
    .locator('xpath=ancestor::section[1]');
}

export async function blockApi(page: Page, down: () => boolean = () => true): Promise<void> {
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      if (down()) {
        await route.abort('connectionrefused');
        return;
      }
      await route.continue();
    },
  );
}

export interface LaunchOptions {
  readonly seed: number;
  readonly label?: string;
}

export async function launchBacktest(page: Page, options: LaunchOptions): Promise<string> {
  const params = panel(page, 'Parametros');

  await expect(params.getByLabel('Estrategia')).toBeEnabled();
  await params.getByLabel('Estrategia').selectOption('ema-cross');
  await params.getByLabel('Semilla').fill(String(options.seed));

  if (options.label !== undefined) {
    await params.getByLabel('Etiqueta').fill(options.label);
  }

  const created = page.waitForResponse(
    (response) =>
      response.url().includes('/api/backtests') &&
      response.request().method() === 'POST' &&
      response.status() === 202,
  );

  await params.getByRole('button', { name: 'Ejecutar backtest' }).click();

  const body: unknown = await (await created).json();
  const parsed = z.object({ runId: z.string().regex(RUN_ID_RE) }).parse(body);

  await expect(page).toHaveURL(new RegExp(`run=${parsed.runId}`));

  return parsed.runId;
}

export async function waitForCompleted(page: Page): Promise<void> {
  await expect(progress(page).getByText('Completado', { exact: true })).toBeVisible();
}

export async function readMetrics(page: Page): Promise<Record<string, string>> {
  const grid = metricsSection(page).locator('dl');
  await expect(grid).toBeVisible();

  const labels = await grid.locator('dt').allInnerTexts();
  const values = await grid.locator('dd').allInnerTexts();

  expect(labels.length).toBeGreaterThan(0);
  expect(values).toHaveLength(labels.length);

  return Object.fromEntries(labels.map((label, index) => [label, values[index] ?? '']));
}
