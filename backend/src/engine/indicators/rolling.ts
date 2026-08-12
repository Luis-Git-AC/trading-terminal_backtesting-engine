import type { Indicator } from '../types.js';
import { assertPeriod } from './period.js';

type Comparator = (candidate: number, incumbent: number) => boolean;

function createRollingExtreme(
  name: string,
  period: number,
  dominates: Comparator,
): Indicator<number> {
  assertPeriod(name, period);

  const capacity = period + 1;
  const values = new Array<number>(capacity).fill(0);
  const positions = new Array<number>(capacity).fill(0);
  let head = 0;
  let size = 0;
  let seen = 0;

  const backSlot = (): number => (head + size - 1) % capacity;

  return {
    update(input: number): number | null {
      while (size > 0 && dominates(input, values[backSlot()] ?? 0)) {
        size -= 1;
      }
      const slot = (head + size) % capacity;
      values[slot] = input;
      positions[slot] = seen;
      size += 1;
      if ((positions[head] ?? 0) <= seen - period) {
        head = (head + 1) % capacity;
        size -= 1;
      }
      seen += 1;
      return seen >= period ? (values[head] ?? null) : null;
    },
    get(): number | null {
      return seen >= period ? (values[head] ?? null) : null;
    },
    get ready(): boolean {
      return seen >= period;
    },
  };
}

export function createRollingMax(period: number): Indicator<number> {
  return createRollingExtreme('RollingMax', period, (candidate, incumbent) => candidate >= incumbent);
}

export function createRollingMin(period: number): Indicator<number> {
  return createRollingExtreme('RollingMin', period, (candidate, incumbent) => candidate <= incumbent);
}
