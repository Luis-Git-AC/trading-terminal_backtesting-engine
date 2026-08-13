// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const INDEX_HTML = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');

describe('index.html', () => {
  it('declara el idioma del documento, que axe no puede auditar desde el contenedor', () => {
    expect(INDEX_HTML).toContain('<html lang="es">');
  });

  it('declara el titulo y los dos esquemas de color que soporta el tema', () => {
    expect(INDEX_HTML).toContain('<title>Trading Terminal</title>');
    expect(INDEX_HTML).toContain('content="dark light"');
  });
});
