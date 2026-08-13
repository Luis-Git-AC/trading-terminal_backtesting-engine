// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const TOKENS = readFileSync(fileURLToPath(new URL('./tokens.css', import.meta.url)), 'utf8');

const AA_NORMAL_TEXT = 4.5;

function colorsIn(source: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const match of source.matchAll(/(--color-[\w-]+):\s*([^;]+);/g)) {
    const name = match[1];
    const value = match[2];
    if (name !== undefined && value !== undefined) {
      found[name] = value.trim();
    }
  }
  return found;
}

function themeBlock(pattern: RegExp): Record<string, string> {
  const match = TOKENS.match(pattern);
  if (match?.[1] === undefined) {
    throw new Error(`No se encontro el bloque de tema: ${pattern.source}`);
  }
  return colorsIn(match[1]);
}

const THEMES = {
  oscuro: themeBlock(/^:root \{([\s\S]*?)\n\}/m),
  claro: themeBlock(/:root\[data-theme='light'\] \{([\s\S]*?)\n\}/),
};

function relativeLuminance(hex: string): number {
  const digits = hex.replace('#', '');
  const channels = [0, 2, 4].map((offset) => parseInt(digits.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
}

export function contrastRatio(foreground: string, background: string): number {
  const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)].sort(
    (a, b) => b - a,
  );
  return ((lighter ?? 0) + 0.05) / ((darker ?? 0) + 0.05);
}

const TEXT_PAIRS: readonly (readonly [string, string])[] = [
  ['--color-text', '--color-bg'],
  ['--color-text', '--color-surface'],
  ['--color-text-secondary', '--color-surface'],
  ['--color-text-tertiary', '--color-surface'],
  ['--color-text-secondary', '--color-surface-raised'],
  ['--color-text-tertiary', '--color-surface-raised'],
  ['--color-accent', '--color-surface'],
  ['--color-up', '--color-surface'],
  ['--color-down', '--color-surface'],
  ['--color-warning', '--color-surface'],
  ['--color-on-accent', '--color-accent'],
];

describe('contraste de la paleta', () => {
  it('la formula reproduce dos referencias conocidas de WCAG', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
  });

  for (const [themeName, theme] of Object.entries(THEMES)) {
    describe(`tema ${themeName}`, () => {
      it('define todos los tokens que se auditan', () => {
        const missing = [...new Set(TEXT_PAIRS.flat())].filter((token) => !(token in theme));
        expect(missing).toEqual([]);
      });

      for (const [foreground, background] of TEXT_PAIRS) {
        it(`${foreground} sobre ${background} cumple AA`, () => {
          const fg = theme[foreground];
          const bg = theme[background];
          expect(fg).toBeDefined();
          expect(bg).toBeDefined();
          expect(contrastRatio(fg ?? '', bg ?? '')).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
        });
      }
    });
  }

  it('el tema claro redefine todos los colores que define el oscuro', () => {
    const onlyInDark = Object.keys(THEMES.oscuro).filter((token) => !(token in THEMES.claro));
    expect(onlyInDark).toEqual([]);
  });
});
