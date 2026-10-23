import { describe, expect, it } from 'vitest';
import type { RankedDocument } from '../../db/repositories/search.repo.js';
import { fuseRankings, RRF_K } from './search.service.js';

function ranking(...ids: string[]): RankedDocument[] {
  return ids.map((documentId, index) => ({ documentId, rank: index + 1 }));
}

describe('fuseRankings (Reciprocal Rank Fusion)', () => {
  it('suma 1/(k+posicion) de cada ranking', () => {
    const fused = fuseRankings(ranking('a'), ranking('a'));
    expect(fused).toEqual([
      { documentId: 'a', score: 2 / (RRF_K + 1), fullTextRank: 1, vectorRank: 1 },
    ]);
  });

  it('un documento bien colocado en los dos rankings gana a un primero en uno solo', () => {
    const fused = fuseRankings(ranking('solo-texto', 'en-los-dos'), ranking('otro', 'en-los-dos'));
    expect(fused[0]?.documentId).toBe('en-los-dos');
    expect(fused[0]?.fullTextRank).toBe(2);
    expect(fused[0]?.vectorRank).toBe(2);
  });

  it('conserva los documentos que solo aparecen en un ranking', () => {
    const fused = fuseRankings(ranking('a'), ranking('b'));
    expect(fused.map((item) => item.documentId).sort()).toEqual(['a', 'b']);
    expect(fused.find((item) => item.documentId === 'a')?.vectorRank).toBeNull();
    expect(fused.find((item) => item.documentId === 'b')?.fullTextRank).toBeNull();
  });

  it('es determinista: el mismo par de rankings da el mismo orden', () => {
    const texto = ranking('a', 'b', 'c', 'd');
    const vector = ranking('c', 'a', 'e');
    const primera = fuseRankings(texto, vector);

    for (let intento = 0; intento < 5; intento += 1) {
      expect(fuseRankings(texto, vector)).toEqual(primera);
    }
    expect(primera.map((item) => item.documentId)).toEqual(['a', 'c', 'b', 'e', 'd']);
  });

  it('con la misma puntuacion desempata por la mejor posicion y luego por id', () => {
    // `z` y `a` empatan a 1/(k+2); `z` esta segundo en texto y `a` segundo en vector.
    const fused = fuseRankings(ranking('otro', 'z'), ranking('otro2', 'a'));
    expect(
      fused.filter((item) => ['a', 'z'].includes(item.documentId)).map((i) => i.documentId),
    ).toEqual(['a', 'z']);
  });

  it('sin ranking vectorial el orden es el de full-text', () => {
    expect(fuseRankings(ranking('a', 'b', 'c'), []).map((item) => item.documentId)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('sin resultados no inventa ninguno', () => {
    expect(fuseRankings([], [])).toEqual([]);
  });
});
