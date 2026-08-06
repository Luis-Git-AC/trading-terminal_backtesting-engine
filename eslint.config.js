import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/*.d.ts',
      'Documentacion/**',
    ],
  },

  js.configs.recommended,

  // --- TypeScript con reglas type-aware ---
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    rules: {
      // CLAUDE.md 6: sin `any`. Si algo es desconocido -> `unknown` + Zod.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',

      // Promesas: un await olvidado en ingesta o worker es un bug silencioso.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/require-await': 'error',

      // verbatimModuleSyntax exige que los imports de tipo esten marcados.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],

      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],

      // `as const` si; `as` para silenciar al compilador no.
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        { assertionStyle: 'as', objectLiteralTypeAssertions: 'never' },
      ],

      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'off',
    },
  },

  // --- Backend: logging estructurado, nunca console ---
  {
    files: ['backend/src/**/*.ts'],
    rules: {
      'no-console': 'error',
    },
  },

  // --- CLI del backend: la salida por stdout es el producto ---
  {
    files: ['backend/src/cli/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },

  // --- Tests: algo mas de holgura, pero nada de .only ---
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/*.itest.ts', 'e2e/**/*.spec.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  // --- Frontend: entorno navegador ---
  {
    files: ['frontend/src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },

  // --- Ficheros JS de configuracion: sin type-aware ---
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  prettier,
);
