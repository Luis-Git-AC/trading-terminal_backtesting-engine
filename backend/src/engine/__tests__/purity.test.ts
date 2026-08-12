import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ENGINE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const FORBIDDEN: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: 'Date.now()', pattern: /\bDate\s*\.\s*now\s*\(/ },
  { label: 'new Date() sin argumentos', pattern: /\bnew\s+Date\s*\(\s*\)/ },
  { label: 'Math.random()', pattern: /\bMath\s*\.\s*random\s*\(/ },
  { label: 'process.env', pattern: /\bprocess\s*\.\s*env\b/ },
  { label: 'fetch()', pattern: /\bfetch\s*\(/ },
  { label: "import de 'pg'", pattern: /['"]pg['"]/ },
  { label: "import de 'ioredis'", pattern: /['"]ioredis['"]/ },
  { label: "import de 'node:fs'", pattern: /['"]node:fs['"]/ },
  { label: "import de 'node:net'", pattern: /['"]node:net['"]/ },
];

const EXCEPTIONS: readonly string[] = [];

function collectSourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === '__bench__') {
        continue;
      }
      found.push(...collectSourceFiles(full));
      continue;
    }
    if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.itest.ts')) {
      found.push(full);
    }
  }
  return found.sort();
}

const SOURCE_FILES = collectSourceFiles(ENGINE_ROOT);

describe('pureza de backend/src/engine', () => {
  it('encuentra los modulos del motor', () => {
    expect(SOURCE_FILES.length).toBeGreaterThan(5);
    expect(EXCEPTIONS).toEqual([]);
  });

  it('ningun modulo usa reloj, aleatoriedad, entorno, red ni base de datos', () => {
    const violations: string[] = [];

    for (const file of SOURCE_FILES) {
      const relativePath = relative(ENGINE_ROOT, file).replace(/\\/g, '/');
      const source = readFileSync(file, 'utf8');
      for (const { label, pattern } of FORBIDDEN) {
        if (pattern.test(source)) {
          violations.push(`${relativePath}: ${label}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('las reglas detectan de verdad cada simbolo prohibido', () => {
    const samples: readonly { readonly code: string; readonly label: string }[] = [
      { code: 'const t = Date.now();', label: 'Date.now()' },
      { code: 'const d = new Date();', label: 'new Date() sin argumentos' },
      { code: 'const r = Math.random();', label: 'Math.random()' },
      { code: 'const v = process.env.FOO;', label: 'process.env' },
      { code: 'await fetch(url);', label: 'fetch()' },
      { code: "import { Pool } from 'pg';", label: "import de 'pg'" },
      { code: "import Redis from 'ioredis';", label: "import de 'ioredis'" },
      { code: "import { readFileSync } from 'node:fs';", label: "import de 'node:fs'" },
      { code: "import { Socket } from 'node:net';", label: "import de 'node:net'" },
    ];

    for (const sample of samples) {
      const rule = FORBIDDEN.find((entry) => entry.label === sample.label);
      expect(rule).toBeDefined();
      expect(rule?.pattern.test(sample.code)).toBe(true);
    }
  });

  it('no marca como prohibido lo que si esta permitido', () => {
    const allowed = [
      "import { createHash } from 'node:crypto';",
      'const d = new Date(candle.t);',
      'const value = prng();',
      'const parsed = Number(row.open);',
    ];

    for (const code of allowed) {
      for (const { pattern } of FORBIDDEN) {
        expect(pattern.test(code)).toBe(false);
      }
    }
  });
});
