import {
  ERROR_CODES,
  ERROR_STATUS,
  errorEnvelopeSchema,
  type ErrorCode,
  type ErrorDetail,
} from '@tt/shared';

export const TRANSPORT_ERROR_CODES = ['NETWORK_ERROR', 'MALFORMED_RESPONSE'] as const;

export type TransportErrorCode = (typeof TRANSPORT_ERROR_CODES)[number];

export type ApiErrorCode = ErrorCode | TransportErrorCode;

const MESSAGES: Record<ApiErrorCode, string> = {
  VALIDATION_ERROR: 'La peticion no es valida.',
  NOT_FOUND: 'No se ha encontrado el recurso.',
  CONFLICT: 'La operacion entra en conflicto con el estado actual.',
  RANGE_TOO_LARGE: 'El rango pedido es demasiado grande.',
  UPSTREAM_UNAVAILABLE: 'La fuente de datos no esta disponible.',
  INTERNAL: 'Error interno del servidor.',
  NETWORK_ERROR: 'No se ha podido contactar con el API.',
  MALFORMED_RESPONSE: 'El API ha respondido algo que no cumple el contrato.',
};

export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly code: ApiErrorCode;
  readonly status: number | null;
  readonly details: readonly ErrorDetail[] | undefined;

  constructor(
    code: ApiErrorCode,
    message: string,
    options: { status?: number | null; details?: readonly ErrorDetail[]; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.status = options.status ?? null;
    this.details = options.details;
  }

  get isTransport(): boolean {
    return TRANSPORT_ERROR_CODES.some((code) => code === this.code);
  }

  static network(cause: unknown): ApiError {
    return new ApiError('NETWORK_ERROR', MESSAGES.NETWORK_ERROR, { cause });
  }

  static malformed(message: string, cause?: unknown): ApiError {
    return new ApiError('MALFORMED_RESPONSE', message, { cause });
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

export function defaultMessageFor(code: ApiErrorCode): string {
  return MESSAGES[code];
}

export function describeApiError(error: unknown): string {
  if (isApiError(error)) {
    return error.message.length > 0 ? error.message : MESSAGES[error.code];
  }
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return MESSAGES.INTERNAL;
}

export function parseErrorEnvelope(body: unknown, status: number): ApiError {
  const parsed = errorEnvelopeSchema.safeParse(body);

  if (parsed.success) {
    const { code, message } = parsed.data.error;
    return new ApiError(code, message.length > 0 ? message : MESSAGES[code], {
      status,
      ...(parsed.data.error.details === undefined ? {} : { details: parsed.data.error.details }),
    });
  }

  const code = ERROR_CODES.find((candidate) => ERROR_STATUS[candidate] === status) ?? 'INTERNAL';
  return new ApiError(code, `${MESSAGES[code]} (HTTP ${status})`, { status });
}
