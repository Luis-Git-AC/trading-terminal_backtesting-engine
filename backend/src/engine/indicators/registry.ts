import type { Candle } from '@tt/shared';
import type { Indicator, IndicatorRegistrar, IndicatorRegistry } from '../types.js';

export class DuplicateIndicatorError extends Error {
  override readonly name = 'DuplicateIndicatorError';
  readonly key: string;

  constructor(key: string) {
    super(`El indicador "${key}" ya esta registrado.`);
    this.key = key;
  }
}

export class UnknownIndicatorError extends Error {
  override readonly name = 'UnknownIndicatorError';
  readonly key: string;

  constructor(key: string, known: readonly string[]) {
    super(`Indicador desconocido "${key}". Registrados: ${known.join(', ') || 'ninguno'}.`);
    this.key = key;
  }
}

export const fromClose = (bar: Candle): number => bar.c;

export const fromBar = (bar: Candle): Candle => bar;

interface Entry {
  readonly key: string;
  readonly step: (bar: Candle) => void;
  readonly read: () => number | null;
  readonly isReady: () => boolean;
}

export interface MutableIndicatorRegistry extends IndicatorRegistry, IndicatorRegistrar {
  updateAll(bar: Candle): void;
  readonly keys: readonly string[];
  readonly allReady: boolean;
}

export function createIndicatorRegistry(): MutableIndicatorRegistry {
  const entries: Entry[] = [];
  const byKey = new Map<string, Entry>();

  const require = (key: string): Entry => {
    const entry = byKey.get(key);
    if (entry === undefined) {
      throw new UnknownIndicatorError(
        key,
        entries.map((item) => item.key),
      );
    }
    return entry;
  };

  return {
    register<TInput>(
      key: string,
      indicator: Indicator<TInput>,
      select: (bar: Candle) => TInput,
    ): void {
      if (byKey.has(key)) {
        throw new DuplicateIndicatorError(key);
      }
      const entry: Entry = {
        key,
        step: (bar) => {
          indicator.update(select(bar));
        },
        read: () => indicator.get(),
        isReady: () => indicator.ready,
      };
      entries.push(entry);
      byKey.set(key, entry);
    },
    updateAll(bar: Candle): void {
      for (const entry of entries) {
        entry.step(bar);
      }
    },
    get(key: string): number | null {
      return require(key).read();
    },
    ready(key: string): boolean {
      return require(key).isReady();
    },
    get keys(): readonly string[] {
      return entries.map((entry) => entry.key);
    },
    get allReady(): boolean {
      return entries.every((entry) => entry.isReady());
    },
  };
}
