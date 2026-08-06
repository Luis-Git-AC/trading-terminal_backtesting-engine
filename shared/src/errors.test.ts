import { describe, expect, it } from 'vitest';
import { ERROR_CODES, ERROR_STATUS, isErrorCode } from './errors.js';

describe('codigos de error del contrato', () => {
  it('son exactamente los de docs/03-API-CONTRACT.md', () => {
    expect(ERROR_CODES).toEqual([
      'VALIDATION_ERROR',
      'NOT_FOUND',
      'CONFLICT',
      'RANGE_TOO_LARGE',
      'UPSTREAM_UNAVAILABLE',
      'INTERNAL',
    ]);
  });

  it('cada codigo mapea al status HTTP documentado', () => {
    expect(ERROR_STATUS).toEqual({
      VALIDATION_ERROR: 400,
      NOT_FOUND: 404,
      CONFLICT: 409,
      RANGE_TOO_LARGE: 413,
      UPSTREAM_UNAVAILABLE: 503,
      INTERNAL: 500,
    });
  });

  it('no hay codigos sin status ni status sin codigo', () => {
    expect(Object.keys(ERROR_STATUS).sort()).toEqual([...ERROR_CODES].sort());
  });

  it('isErrorCode discrimina', () => {
    expect(isErrorCode('NOT_FOUND')).toBe(true);
    expect(isErrorCode('TEAPOT')).toBe(false);
    expect(isErrorCode(404)).toBe(false);
    expect(isErrorCode(null)).toBe(false);
  });
});
