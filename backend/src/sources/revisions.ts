import type { MacroPoint, MacroRepository } from '../db/repositories/macro.repo.js';

export interface RevisableObservation {
  readonly t: number;
  readonly value: number;
  readonly publishedAt: number;
  readonly fetchedAt: number;
}

/**
 * Numero de revision deducido de lo ya guardado, para las fuentes que **no** sirven vintages: una
 * peticion devuelve solo el valor vigente de cada fecha, asi que la revision no esta en la
 * respuesta. Un valor igual al ultimo conocido no se reescribe (de ahi la idempotencia) y uno
 * distinto entra como la revision siguiente, conviviendo con el original en vez de sobrescribirlo.
 */
export async function withRevisions(
  macroRepo: MacroRepository,
  ref: { source: string; seriesId: string },
  items: readonly RevisableObservation[],
): Promise<MacroPoint[]> {
  const timestamps = items.map((item) => item.t);
  const stored = new Map<number, MacroPoint>();

  if (timestamps.length > 0) {
    const points = await macroRepo.getPoints({
      ...ref,
      from: Math.min(...timestamps),
      to: Math.max(...timestamps),
    });
    for (const point of points) stored.set(point.t, point);
  }

  const result: MacroPoint[] = [];
  for (const item of items) {
    const last = stored.get(item.t);
    if (last?.value === item.value) continue;
    result.push({
      t: item.t,
      value: item.value,
      publishedAt: item.publishedAt,
      fetchedAt: item.fetchedAt,
      revision: last === undefined ? 0 : last.revision + 1,
    });
  }
  return result;
}
