import { defineConfig } from 'vitest/config';

/**
 * Piramide de tests segun docs/05-TESTING.md.
 *
 *   shared / backend / frontend  -> unitarios   (*.test.ts, *.test.tsx)
 *   backend:int                  -> integracion (*.itest.ts, necesita Docker: Postgres + Redis)
 *
 * `npm run test` ejecuta todos los proyectos (unit + int).
 * `npm run test:unit` omite integracion. `npm run test:engine` filtra por ruta del motor.
 */
export default defineConfig({
  test: {
    // Necesario a nivel raiz ademas de por proyecto: si un filtro (`test:engine`) o un proyecto
    // aun sin ficheros (`backend:int`) deja la ejecucion entera a cero, Vitest saldria con codigo 1.
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
          // La integracion toca una BD real: sin paralelismo entre ficheros.
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
