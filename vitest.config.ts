import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['shared/src/**/*.ts', 'backend/src/**/*.ts', 'frontend/src/**/*.{ts,tsx}'],
      exclude: [
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/*.itest.ts',
        'backend/src/cli/**',
        'backend/src/testing/**',
        'backend/src/engine/__bench__/**',
      ],
    },
    projects: [
      {
        test: {
          name: 'shared',
          root: './shared',
          environment: 'node',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'backend',
          root: './backend',
          environment: 'node',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'backend:int',
          root: './backend',
          environment: 'node',
          include: ['src/**/*.itest.ts'],
          setupFiles: ['./src/testing/int-setup.ts'],
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
      {
        test: {
          name: 'e2e:setup',
          root: '.',
          environment: 'node',
          include: ['e2e/**/*.test.ts', 'scripts/**/*.test.ts'],
          setupFiles: ['./e2e/test-setup.ts'],
        },
      },
      './frontend/vite.config.ts',
    ],
  },
});
