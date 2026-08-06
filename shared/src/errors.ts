export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'CONFLICT',
  'RANGE_TOO_LARGE',
  'UPSTREAM_UNAVAILABLE',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_STATUS = {
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RANGE_TOO_LARGE: 413,
  UPSTREAM_UNAVAILABLE: 503,
  INTERNAL: 500,
} as const satisfies Record<ErrorCode, number>;

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && ERROR_CODES.some((code) => code === value);
}
