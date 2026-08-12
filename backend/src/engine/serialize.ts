import { createHash } from 'node:crypto';
import { round10 } from './num.js';
import type { BacktestResult } from './types.js';

export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

export class NonSerializableValueError extends Error {
  override readonly name = 'NonSerializableValueError';
  readonly path: string;

  constructor(path: string, detail: string) {
    super(`Valor no serializable en "${path || '<raiz>'}": ${detail}`);
    this.path = path;
  }
}

function canonicalizeAt(value: unknown, path: string): CanonicalValue {
  if (value === null) {
    return null;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new NonSerializableValueError(path, `numero no finito (${String(value)})`);
    }
    return round10(value);
  }
  if (typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => canonicalizeAt(item, `${path}[${index}]`));
  }
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const result: Record<string, CanonicalValue> = {};
    for (const key of Object.keys(source).sort()) {
      const entry = source[key];
      if (entry === undefined) {
        continue;
      }
      result[key] = canonicalizeAt(entry, path ? `${path}.${key}` : key);
    }
    return result;
  }
  throw new NonSerializableValueError(path, `tipo ${typeof value}`);
}

export function canonicalize(value: unknown): CanonicalValue {
  return canonicalizeAt(value, '');
}

export function serializeCanonical(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function hashResult(result: BacktestResult): string {
  return sha256(serializeCanonical(result));
}
