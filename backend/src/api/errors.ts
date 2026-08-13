import { ERROR_STATUS, type ErrorCode, type ErrorDetail, type ErrorEnvelope } from '@tt/shared';

export type { ErrorDetail, ErrorEnvelope };

export class AppError extends Error {
  override readonly name = 'AppError';
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: readonly ErrorDetail[] | undefined;

  constructor(code: ErrorCode, message: string, details?: readonly ErrorDetail[]) {
    super(message);
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details = details;
  }

  toEnvelope(): ErrorEnvelope {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }

  static notFound(message: string): AppError {
    return new AppError('NOT_FOUND', message);
  }

  static validation(message: string, details: readonly ErrorDetail[]): AppError {
    return new AppError('VALIDATION_ERROR', message, details);
  }

  static rangeTooLarge(message: string): AppError {
    return new AppError('RANGE_TOO_LARGE', message);
  }
}
