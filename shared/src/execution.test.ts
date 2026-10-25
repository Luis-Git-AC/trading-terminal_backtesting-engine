import { describe, expect, it } from 'vitest';
import { isEmptyBlackout } from './execution.js';

const BLACKOUT = { types: ['eia-wpsr' as const], beforeMs: 0, afterMs: 0 };

describe('isEmptyBlackout', () => {
  it('solo marca un blackout pedido que no dejo ninguna ventana', () => {
    expect(isEmptyBlackout({ eventBlackout: BLACKOUT })).toBe(true);
    expect(isEmptyBlackout({ eventBlackout: BLACKOUT, blockedWindows: [] })).toBe(true);
    expect(isEmptyBlackout({ eventBlackout: BLACKOUT, blockedWindows: [{ from: 1, to: 2 }] })).toBe(
      false,
    );
    expect(isEmptyBlackout({ blockedWindows: [] })).toBe(false);
    expect(isEmptyBlackout({})).toBe(false);
  });
});
