import type { RateLimiter } from '../ingest/rate-limiter.js';

/**
 * Las dos marcas point-in-time de ADR-006, obligatorias en el tipo para que una fuente nueva
 * no pueda olvidarlas: `publishedAt` es cuándo lo publicó la fuente y `fetchedAt` cuándo lo
 * obtuvo el sistema.
 */
export interface SourceItem {
  readonly publishedAt: number;
  readonly fetchedAt: number;
}

export interface NormalizedBatch<TItem extends SourceItem = SourceItem> {
  readonly sourceId: string;
  readonly items: readonly TItem[];
  readonly discarded: number;
}

export interface PersistResult {
  readonly written: number;
  readonly skipped: number;
}

export interface SourceContext {
  readonly limiter: RateLimiter;
  readonly now: () => number;
}

export interface SourceAdapter<TRaw, TItem extends SourceItem> {
  readonly id: string;
  /** Cron del job repeatable. */
  readonly schedule: string;
  /** Claves de entorno sin las que la fuente no puede trabajar; su ausencia la desactiva. */
  readonly requiredEnv?: readonly string[];
  /** Peticiones por segundo propias, cuando el limite de la fuente es mas estricto que el comun. */
  readonly rps?: number | undefined;
  fetch(since: Date | null, context: SourceContext): Promise<TRaw>;
  normalize(raw: TRaw): NormalizedBatch<TItem>;
  persist(batch: NormalizedBatch<TItem>): Promise<PersistResult>;
}

export interface SourceRunReport {
  readonly sourceId: string;
  readonly items: number;
  readonly discarded: number;
  readonly written: number;
  readonly skipped: number;
  readonly durationMs: number;
}

/**
 * Una fuente con sus tipos ya cerrados. El registro guarda estas, no `SourceAdapter`: con los
 * genéricos abiertos no hay tipo común al que puedan asignarse dos fuentes distintas.
 */
export interface RunnableSource {
  readonly id: string;
  readonly schedule: string;
  readonly requiredEnv: readonly string[];
  readonly rps?: number | undefined;
  run(since: Date | null, context: SourceContext): Promise<SourceRunReport>;
}

/**
 * Compone las tres fases en el orden de ADR-006: se trae el crudo, se valida y solo entonces se
 * escribe. Un fallo en cualquiera de las tres sube al llamante, que decide si reintenta.
 */
export function toRunnable<TRaw, TItem extends SourceItem>(
  source: SourceAdapter<TRaw, TItem>,
): RunnableSource {
  return {
    id: source.id,
    schedule: source.schedule,
    requiredEnv: source.requiredEnv ?? [],
    ...(source.rps === undefined ? {} : { rps: source.rps }),

    async run(since: Date | null, context: SourceContext): Promise<SourceRunReport> {
      const startedAt = context.now();
      const raw = await source.fetch(since, context);
      const batch = source.normalize(raw);
      const persisted = await source.persist(batch);

      return {
        sourceId: source.id,
        items: batch.items.length,
        discarded: batch.discarded,
        written: persisted.written,
        skipped: persisted.skipped,
        durationMs: context.now() - startedAt,
      };
    },
  };
}
