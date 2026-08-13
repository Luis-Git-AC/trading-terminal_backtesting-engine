// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_DIR = fileURLToPath(new URL('..', import.meta.url));
const TOKENS_FILE = join(SRC_DIR, 'styles', 'tokens.css');

const SCANNED_EXTENSIONS = new Set(['.css', '.ts', '.tsx']);
const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch|color-mix)\(/g;

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      return listFiles(full);
    }
    return SCANNED_EXTENSIONS.has(extname(entry.name)) ? [full] : [];
  });
}

describe('tokens.css es la unica fuente de color', () => {
  it('ningun otro fichero de src declara un literal de color', () => {
    const auditsColorItself = new Set([
      TOKENS_FILE,
      fileURLToPath(import.meta.url),
      join(SRC_DIR, 'styles', 'contrast.test.ts'),
    ]);

    const offenders = listFiles(SRC_DIR)
      .filter((file) => !auditsColorItself.has(file))
      .flatMap((file) => {
        const matches = readFileSync(file, 'utf8').match(COLOR_LITERAL) ?? [];
        return matches.map((match) => `${relative(SRC_DIR, file).split(sep).join('/')}: ${match}`);
      });

    expect(offenders).toEqual([]);
  });

  it('tokens.css define los roles de color que exige el ticket', () => {
    const tokens = readFileSync(TOKENS_FILE, 'utf8');

    for (const token of [
      '--color-bg',
      '--color-surface',
      '--color-border',
      '--color-text',
      '--color-accent',
      '--color-up',
      '--color-down',
      '--space-4',
      '--font-sans',
      '--font-mono',
      '--radius-md',
      '--shadow-md',
      '--z-modal',
    ]) {
      expect(tokens).toContain(`${token}:`);
    }
  });
});
