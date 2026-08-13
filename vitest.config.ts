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
          passWithNoTests: true,
        },
      },
      {
        test: {
          name: 'backend',
          root: './backend',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          passWithNoTests: true,
        },
      },
      {
        test: {
          name: 'backend:int',
          root: './backend',
          environment: 'node',
          include: ['src/**/*.itest.ts'],
          setupFiles: ['./src/testing/int-setup.ts'],
          passWithNoTests: true,
          testTimeout: 60_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
      './frontend/vite.config.ts',
    ],
  },
});
