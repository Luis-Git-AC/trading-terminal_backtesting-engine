import { z } from 'zod';

export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'CONFLICT',
  'RANGE_TOO_LARGE',
  'RATE_LIMITED',
  'UPSTREAM_UNAVAILABLE',
  'INTERNAL',
  'UNKNOWN_EXCHANGE',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_STATUS = {
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RANGE_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  UPSTREAM_UNAVAILABLE: 503,
  INTERNAL: 500,
  UNKNOWN_EXCHANGE: 404,
} as const satisfies Record<ErrorCode, number>;

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && ERROR_CODES.some((code) => code === value);
}

export const errorCodeSchema = z.enum(ERROR_CODES);

export const errorDetailSchema = z.object({
  path: z.string(),
  message: z.string(),
});

export type ErrorDetail = z.infer<typeof errorDetailSchema>;

export const errorEnvelopeSchema = z.object({
  error: z
    .object({
      code: errorCodeSchema,
      message: z.string(),
      details: z.array(errorDetailSchema).readonly().optional(),
    })
    .readonly(),
});

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
