import { describe, expect, it } from 'vitest';
import { stepNumber } from '@/components/StrategyPanel/NumberStepper';

describe('stepNumber', () => {
  it('suma y resta un paso', () => {
    expect(stepNumber('12', 1, 1, 2, 200)).toBe('13');
    expect(stepNumber('12', -1, 1, 2, 200)).toBe('11');
  });

  it('no se sale de los limites del parametro', () => {
    expect(stepNumber('200', 1, 1, 2, 200)).toBe('200');
    expect(stepNumber('2', -1, 1, 2, 200)).toBe('2');
    expect(stepNumber('999', 1, 1, 2, 200)).toBe('200');
  });

  it('con pasos decimales no arrastra error de coma flotante', () => {
    expect(stepNumber('0.2', 0.1, 0.1, 0, 100)).toBe('0.3');
    expect(stepNumber('6', 0.5, 0.5, 0, 1000)).toBe('6.5');
  });

  it('un campo vacio o no numerico arranca desde el minimo', () => {
    expect(stepNumber('', 1, 1, 2, 200)).toBe('3');
    expect(stepNumber('abc', 1, 1, undefined, undefined)).toBe('1');
  });
});
