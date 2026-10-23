import { describe, expect, it } from 'vitest';
import { CHUNK_CHARS, CHUNK_OVERLAP_CHARS, chunkDocument } from './chunk.js';

const PARRAFO = 'La OPEP mantuvo sus cuotas y el Brent cerro a la baja. '.repeat(12).trim();

describe('chunkDocument', () => {
  it('es determinista: el mismo documento da siempre los mismos trozos', () => {
    const doc = { title: 'Brent cierra a la baja', body: `${PARRAFO}\n\n${PARRAFO}` };
    const primera = chunkDocument(doc);

    expect(primera.length).toBeGreaterThan(1);
    for (let intento = 0; intento < 5; intento += 1) {
      expect(chunkDocument(doc)).toEqual(primera);
    }
  });

  it('el titulo abre el primer trozo', () => {
    const chunks = chunkDocument({ title: 'FOMC sin cambios', body: PARRAFO });
    expect(chunks[0]).toMatch(/^FOMC sin cambios/u);
  });

  it('ningun trozo pasa del tamano pedido', () => {
    const chunks = chunkDocument(
      { title: 'T', body: Array.from({ length: 20 }, () => PARRAFO).join('\n\n') },
      { size: 300, overlap: 50 },
    );
    expect(chunks.length).toBeGreaterThan(5);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(300);
  });

  it('cada trozo arrastra el final del anterior como solape', () => {
    const chunks = chunkDocument(
      { title: '', body: Array.from({ length: 6 }, () => PARRAFO).join('\n\n') },
      { size: 200, overlap: 40 },
    );

    for (const [index, chunk] of chunks.entries()) {
      if (index === 0) continue;
      const anterior = chunks[index - 1]!;
      expect(chunk.startsWith(anterior.slice(-40))).toBe(true);
    }
  });

  it('sin solape los trozos no se repiten nada', () => {
    const chunks = chunkDocument({ title: 'a', body: PARRAFO }, { size: 120, overlap: 0 });
    expect(chunks.join('')).not.toContain('\n');
    expect(chunks.every((chunk) => chunk.length <= 120)).toBe(true);
  });

  it('un parrafo mas largo que el presupuesto se corta por dentro', () => {
    const largo = 'x'.repeat(500);
    const chunks = chunkDocument({ title: '', body: largo }, { size: 100, overlap: 20 });
    expect(chunks).toHaveLength(7);
    expect(chunks.every((chunk) => chunk.length <= 100)).toBe(true);
  });

  it('agrupa parrafos cortos en un solo trozo', () => {
    const chunks = chunkDocument({ title: 'Titulo', body: 'Uno.\n\nDos.\n\nTres.' });
    expect(chunks).toEqual(['Titulo\nUno.\nDos.\nTres.']);
  });

  it('un documento vacio no da ningun trozo', () => {
    expect(chunkDocument({ title: '   ', body: '\n\n  \n\n' })).toEqual([]);
  });

  it('los tamanos por defecto son los que espera el modelo', () => {
    expect(CHUNK_CHARS).toBe(1200);
    expect(CHUNK_OVERLAP_CHARS).toBe(200);
    expect(chunkDocument({ title: 'corto', body: 'texto corto' })).toEqual(['corto\ntexto corto']);
  });
});
