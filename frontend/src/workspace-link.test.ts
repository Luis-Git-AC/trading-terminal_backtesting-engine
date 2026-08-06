import { describe, expect, it } from 'vitest';
import { SHARED_VERSION } from '@tt/shared';

describe('enlace del workspace', () => {
  it('resuelve @tt/shared desde el frontend', () => {
    expect(SHARED_VERSION).toBe('0.1.0');
  });

  it('corre en un entorno con DOM', () => {
    expect(typeof document).toBe('object');
  });
});
