import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const API_PROXY_TARGET = process.env.API_PROXY_TARGET ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: API_PROXY_TARGET,
        changeOrigin: false,
      },
    },
  },
  build: {
    target: 'es2023',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          charts: ['lightweight-charts'],
          plots: ['recharts'],
        },
      },
    },
  },
  test: {
    name: 'frontend',
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
    passWithNoTests: true,
  },
});
