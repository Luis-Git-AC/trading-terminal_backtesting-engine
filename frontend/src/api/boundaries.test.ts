// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_DIR = fileURLToPath(new URL('..', import.meta.url));
const API_DIR = join(SRC_DIR, 'api');
const MSW_DIR = join(SRC_DIR, 'test', 'msw');

const SCANNED = new Set(['.ts', '.tsx']);
const NETWORK_CALL =
  /\b(?:globalThis\.)?fetch\s*\(|new\s+(?:XMLHttpRequest|EventSource|WebSocket)\b/g;

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      return listFiles(full);
    }
    return SCANNED.has(extname(entry.name)) ? [full] : [];
  });
}

function rel(file: string): string {
  return relative(SRC_DIR, file).split(sep).join('/');
}

describe('la red solo se toca desde api/', () => {
  it('ningun fichero fuera de api/ llama a fetch ni abre una conexion', () => {
    const offenders = listFiles(SRC_DIR)
      .filter((file) => !file.startsWith(API_DIR))
      .filter((file) => !file.startsWith(MSW_DIR))
      .filter((file) => file !== fileURLToPath(import.meta.url))
      .flatMap((file) => {
        const matches = readFileSync(file, 'utf8').match(NETWORK_CALL) ?? [];
        return matches.map((match) => `${rel(file)}: ${match.trim()}`);
      });

    expect(offenders).toEqual([]);
  });

  it('el guard reconoceria una llamada directa (control negativo)', () => {
    const sample = 'const data = await fetch("/api/markets");';

    expect(sample.match(NETWORK_CALL)).not.toBeNull();
  });
});
