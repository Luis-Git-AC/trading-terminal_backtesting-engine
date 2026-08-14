import { defineConfig, devices } from '@playwright/test';

export const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 5173);
export const WEB_URL = process.env.E2E_WEB_URL ?? `http://localhost:${String(WEB_PORT)}`;

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  outputDir: './test-results',

  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  globalSetup: './e2e/global-setup.ts',

  reporter: process.env.CI === undefined ? [['list']] : [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 15_000,
    timezoneId: 'UTC',
    locale: 'es-ES',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: {
    command: 'npm run dev:web',
    url: WEB_URL,
    reuseExistingServer: process.env.CI === undefined,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
