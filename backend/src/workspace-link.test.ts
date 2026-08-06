import { describe, expect, it } from 'vitest';
import { SHARED_VERSION } from '@tt/shared';

/**
 * Criterio de aceptacion de F1-T1: `@tt/shared` se importa desde `backend` y compila.
 * Este test es el canario del cableado del monorepo (workspaces + paths de TS).
 */
describe('enlace del workspace', () => {
  it('resuelve @tt/shared desde el backend', () => {
    expect(SHARED_VERSION).toBe('0.1.0');
  });
});
