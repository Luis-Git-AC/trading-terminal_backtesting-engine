import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
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
          passWithNoTests: true,
          testTimeout: 60_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
      {
        test: {
          name: 'frontend',
          root: './frontend',
          environment: 'jsdom',
          include: ['src/**/*.test.{ts,tsx}'],
          passWithNoTests: true,
        },
      },
    ],
  },
});
