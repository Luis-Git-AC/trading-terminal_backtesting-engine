import type { ErrorCode } from '@tt/shared';

export interface UpstreamErrorDetails {
  attempts?: number;
  status?: number | undefined;
  exchangeCode?: string | undefined;
  retryable?: boolean;
  cause?: unknown;
}

export class UpstreamError extends Error {
  override readonly name = 'UpstreamError';
  readonly code: ErrorCode = 'UPSTREAM_UNAVAILABLE';
  readonly attempts: number;
  readonly status: number | undefined;
  readonly exchangeCode: string | undefined;
  readonly retryable: boolean;

  constructor(message: string, details: UpstreamErrorDetails = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.attempts = details.attempts ?? 1;
    this.status = details.status;
    this.exchangeCode = details.exchangeCode;
    this.retryable = details.retryable ?? false;
  }
}
