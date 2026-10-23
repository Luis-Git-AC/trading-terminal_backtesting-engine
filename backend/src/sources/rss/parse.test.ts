import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FeedParseError, parseFeed, sanitizeToText } from './parse.js';

function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../__fixtures__/rss/${name}.xml`, import.meta.url)),
    'utf8',
  );
}

describe('sanitizeToText', () => {
  it('se lleva el <script> entero, no solo sus etiquetas', () => {
    const texto = sanitizeToText('<p>Hola</p><script>alert("x")</script><p>mundo</p>');
    expect(texto).toBe('Hola mundo');
    expect(texto).not.toContain('alert');
  });

  it('decodifica entidades despues de quitar etiquetas, asi que un <script> escapado es texto', () => {
    expect(sanitizeToText('a &lt;script&gt;alert(1)&lt;/script&gt; b')).toBe(
      'a <script>alert(1)</script> b',
    );
  });

  it('colapsa espacios y resuelve entidades numericas', () => {
    expect(sanitizeToText('  oro\n\t&#8364;&#x20AC;&nbsp;y  plata ')).toBe('oro €€ y plata');
  });

  it('una etiqueta sin cerrar al final se lleva el resto', () => {
    expect(sanitizeToText('visible <span onerror="x"')).toBe('visible');
  });
});

describe('parseFeed', () => {
  it('lee RSS 2.0 con CDATA, enlace y fecha', () => {
    const entries = parseFeed(fixture('crypto-rss'));
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      title: 'Gold holds above 4,000',
      url: 'https://example.test/gold-holds?utm_source=rss&utm_medium=feed',
      body: 'Spot gold held above $4,000 an ounce.',
      publishedAt: Date.UTC(2026, 9, 21, 9, 30, 0),
      lang: 'en',
    });
    expect(entries[2]?.body).toBe('Crude inventories fell by 3.1 million barrels.');
  });

  it('lee Atom con <link href> y <summary> escapado', () => {
    const entries = parseFeed(fixture('fed-atom'));
    expect(entries).toEqual([
      {
        title: 'FOMC statement',
        url: 'https://example.test/fomc-20261021',
        body: 'The Committee decided to maintain the target range.',
        publishedAt: Date.UTC(2026, 9, 21, 18, 0, 0),
        lang: 'en',
      },
    ]);
  });

  it('usa el idioma de respaldo cuando el feed no declara el suyo', () => {
    const xml = '<rss version="2.0"><channel><item><link>u</link></item></channel></rss>';
    expect(parseFeed(xml, 'es')[0]?.lang).toBe('es');
    expect(parseFeed(xml)[0]?.lang).toBeNull();
  });

  it('un XML malformado es FeedParseError, no una lista vacia', () => {
    expect(() => parseFeed(fixture('roto'))).toThrow(FeedParseError);
  });

  it('un XML valido que no es feed tambien es FeedParseError', () => {
    expect(() => parseFeed('<html><body>no soy un feed</body></html>')).toThrow(FeedParseError);
  });
});
