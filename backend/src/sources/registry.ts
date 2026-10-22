import type { RunnableSource } from './adapter.js';

export interface SourceRegistryEntry {
  readonly source: RunnableSource;
  /** Claves de entorno que faltan; si hay alguna, la fuente queda fuera. */
  readonly missingEnv: readonly string[];
}

export interface BuildRegistryOptions {
  readonly candidates: readonly RunnableSource[];
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface SourceRegistry {
  readonly enabled: readonly RunnableSource[];
  readonly disabled: readonly SourceRegistryEntry[];
  get(id: string): RunnableSource | undefined;
}

function missingKeys(
  source: RunnableSource,
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  return source.requiredEnv.filter((key) => {
    const value = env[key];
    return value === undefined || value.length === 0;
  });
}

/**
 * Separa las fuentes que pueden trabajar de las que no. Sin la clave de una fuente el proceso no
 * muere: esto es una terminal personal, no un servicio, asi que la fuente se omite con un aviso.
 */
export function buildSourceRegistry(options: BuildRegistryOptions): SourceRegistry {
  const enabled: RunnableSource[] = [];
  const disabled: SourceRegistryEntry[] = [];

  for (const source of options.candidates) {
    const missingEnv = missingKeys(source, options.env);
    if (missingEnv.length > 0) disabled.push({ source, missingEnv });
    else enabled.push(source);
  }

  const byId = new Map(enabled.map((source) => [source.id, source]));

  return {
    enabled,
    disabled,
    get: (id: string) => byId.get(id),
  };
}
