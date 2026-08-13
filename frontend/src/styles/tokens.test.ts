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

  it('ningun modulo declara espaciado, tipografia ni radios a mano', () => {
    const scaled = new Set([
      'padding',
      'padding-top',
      'padding-right',
      'padding-bottom',
      'padding-left',
      'padding-inline',
      'padding-block',
      'margin',
      'margin-top',
      'margin-right',
      'margin-bottom',
      'margin-left',
      'margin-inline',
      'margin-inline-start',
      'margin-inline-end',
      'margin-block',
      'gap',
      'row-gap',
      'column-gap',
      'font-size',
      'border-radius',
    ]);

    const literals = new Set(['0', 'auto', 'inherit', 'initial', 'unset']);

    const offenders = listFiles(SRC_DIR)
      .filter((file) => file.endsWith('.module.css'))
      .flatMap((file) => {
        const source = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
        const found: string[] = [];

        for (const match of source.matchAll(/([a-z-]+)\s*:\s*([^;{}]+);/g)) {
          const property = match[1];
          const value = match[2];
          if (property === undefined || value === undefined || !scaled.has(property)) {
            continue;
          }

          const hardcoded = value
            .split(/\s+/)
            .filter((part) => part !== '')
            .filter((part) => !part.startsWith('var(--'))
            .filter((part) => !literals.has(part));

          for (const part of hardcoded) {
            found.push(`${relative(SRC_DIR, file).split(sep).join('/')}: ${property}: ${part}`);
          }
        }

        return found;
      });

    expect(offenders).toEqual([]);
  });

  it('el anillo de foco vive solo en global.css: ningun modulo lo apaga', () => {
    const offenders = listFiles(SRC_DIR)
      .filter((file) => file.endsWith('.module.css'))
      .filter((file) => /:focus\b|:focus-visible\b|outline\s*:/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC_DIR, file).split(sep).join('/'));

    expect(offenders).toEqual([]);
    expect(readFileSync(join(SRC_DIR, 'styles', 'global.css'), 'utf8')).toContain(
      'box-shadow: var(--shadow-focus);',
    );
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
