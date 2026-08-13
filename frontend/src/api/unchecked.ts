export function trustUnchecked<T>(value: unknown): T {
  return value as T;
}
