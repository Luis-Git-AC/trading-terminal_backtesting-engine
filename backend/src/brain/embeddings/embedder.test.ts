import { describe, expect, it, vi } from 'vitest';
import {
  createTransformersEmbedder,
  DEFAULT_EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
  EmbedderUnavailableError,
  type FeatureExtractor,
} from './embedder.js';

/** Nunca descarga nada: el `load` inyectado sustituye al pipeline de transformers.js. */
function fakeExtractor(vectors: number[][]): { extractor: FeatureExtractor; calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    extractor: (texts, options) => {
      calls.push([texts, options]);
      return Promise.resolve({ tolist: () => vectors.slice(0, texts.length) });
    },
  };
}

const VECTOR = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, index) => index / 1000);

describe('createTransformersEmbedder', () => {
  it('declara el modelo y la dimension de la columna', () => {
    const embedder = createTransformersEmbedder({ load: () => Promise.reject(new Error('no')) });
    expect(embedder.model).toBe(DEFAULT_EMBEDDING_MODEL);
    expect(embedder.dimensions).toBe(384);
  });

  it('pide pooling por media y normalizado, que es lo que espera la busqueda por coseno', async () => {
    const fake = fakeExtractor([VECTOR, VECTOR]);
    const embedder = createTransformersEmbedder({ load: () => Promise.resolve(fake.extractor) });

    const vectors = await embedder.embed(['hola', 'adios']);
    expect(vectors).toHaveLength(2);
    expect(fake.calls[0]?.[1]).toEqual({ pooling: 'mean', normalize: true });
  });

  it('carga el modelo una sola vez aunque se le pidan varios lotes', async () => {
    const fake = fakeExtractor([VECTOR]);
    const load = vi.fn(() => Promise.resolve(fake.extractor));
    const embedder = createTransformersEmbedder({ load });

    await embedder.embed(['uno']);
    await embedder.embed(['dos']);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('sin textos no carga el modelo', async () => {
    const load = vi.fn(() => Promise.reject(new Error('no deberia cargarse')));
    expect(await createTransformersEmbedder({ load }).embed([])).toEqual([]);
    expect(load).not.toHaveBeenCalled();
  });

  it('si el modelo no esta y no hay red, el fallo es EmbedderUnavailableError', async () => {
    const embedder = createTransformersEmbedder({
      load: () => Promise.reject(new Error('getaddrinfo ENOTFOUND huggingface.co')),
    });

    await expect(embedder.embed(['algo'])).rejects.toThrow(EmbedderUnavailableError);
    await expect(embedder.embed(['algo'])).rejects.toThrow(/ENOTFOUND/u);
  });

  it('un fallo de carga no se queda cacheado: el siguiente intento vuelve a probar', async () => {
    const fake = fakeExtractor([VECTOR]);
    let intentos = 0;
    const embedder = createTransformersEmbedder({
      load: () => {
        intentos += 1;
        return intentos === 1
          ? Promise.reject(new Error('red caida'))
          : Promise.resolve(fake.extractor);
      },
    });

    await expect(embedder.embed(['algo'])).rejects.toThrow(EmbedderUnavailableError);
    expect(await embedder.embed(['algo'])).toEqual([VECTOR]);
    expect(intentos).toBe(2);
  });

  it('si el modelo devuelve menos vectores que textos, revienta en vez de desalinear', async () => {
    const fake = fakeExtractor([VECTOR]);
    const embedder = createTransformersEmbedder({
      load: () =>
        Promise.resolve((texts, options) => {
          void texts;
          return fake.extractor(['solo-uno'], options);
        }),
    });

    await expect(embedder.embed(['uno', 'dos'])).rejects.toThrow(/devolvio 1 vectores para 2/u);
  });
});
