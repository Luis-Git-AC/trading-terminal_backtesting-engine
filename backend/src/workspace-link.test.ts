import { describe, expect, it } from 'vitest';
import { SHARED_VERSION } from '@tt/shared';

describe('enlace del workspace', () => {
  it('resuelve @tt/shared desde el backend', () => {
    expect(SHARED_VERSION).toBe('0.1.0');
  });
});
