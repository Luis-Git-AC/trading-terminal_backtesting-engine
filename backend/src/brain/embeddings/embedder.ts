/** Dimension del modelo por defecto. Esta en el tipo de la columna: cambiarla es una migracion. */
export const EMBEDDING_DIMENSIONS = 384;

export const DEFAULT_EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';

export interface Embedder {
  readonly model: string;
  readonly dimensions: number;
  /** Un vector por texto, en el mismo orden. */
  embed(texts: readonly string[]): Promise<number[][]>;
}

export class EmbedderUnavailableError extends Error {
  override readonly name = 'EmbedderUnavailableError';
}

export interface TransformersEmbedderOptions {
  readonly model?: string;
  readonly dimensions?: number;
  /** Punto de inyeccion de los tests: sin esto habria que descargar el modelo para probar algo. */
  readonly load?: () => Promise<FeatureExtractor>;
}

/** Lo que se usa del `pipeline('feature-extraction')` de transformers.js, y nada mas. */
export type FeatureExtractor = (
  texts: readonly string[],
  options: { pooling: 'mean'; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

async function loadPipeline(model: string): Promise<FeatureExtractor> {
  // Import dinamico: cargar transformers.js arrastra onnxruntime, y los roles que no hacen
  // embeddings (api, worker, collector) no tienen por que pagarlo al arrancar.
  const { pipeline } = await import('@huggingface/transformers');
  const extractor = await pipeline('feature-extraction', model);
  return (texts, options) => extractor([...texts], options);
}

/**
 * Embeddings locales y sin coste. El modelo se carga **una vez y al primer uso**: si no esta en la
 * cache (`HF_HOME`) y no hay red, el fallo sube como `EmbedderUnavailableError` para que `brain`
 * arranque degradado en vez de morir.
 */
export function createTransformersEmbedder(options: TransformersEmbedderOptions = {}): Embedder {
  const model = options.model ?? DEFAULT_EMBEDDING_MODEL;
  const load = options.load ?? (() => loadPipeline(model));
  let extractor: Promise<FeatureExtractor> | undefined;

  return {
    model,
    dimensions: options.dimensions ?? EMBEDDING_DIMENSIONS,

    async embed(texts: readonly string[]): Promise<number[][]> {
      if (texts.length === 0) return [];

      extractor ??= load().catch((error: unknown) => {
        // Sin esto, un fallo de carga quedaria cacheado como promesa rechazada para siempre.
        extractor = undefined;
        throw new EmbedderUnavailableError(
          `no se pudo cargar el modelo ${model}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });

      const output = await (await extractor)(texts, { pooling: 'mean', normalize: true });
      const vectors = output.tolist();

      if (vectors.length !== texts.length) {
        throw new Error(
          `el modelo ${model} devolvio ${String(vectors.length)} vectores para ${String(texts.length)} textos`,
        );
      }
      return vectors;
    },
  };
}
