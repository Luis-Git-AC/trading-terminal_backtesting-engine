import { describe, expect, it } from 'vitest';
import { PRECISION_DECIMALS, addPnl, bps, round10 } from './num.js';

describe('round10', () => {
  it('absorbe el error binario clasico de 0.1 + 0.2', () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(round10(0.1 + 0.2)).toBe(0.3);
  });

  it('hace lo mismo con el negativo', () => {
    expect(round10(-0.1 - 0.2)).toBe(-0.3);
  });

  it('recorta a 10 decimales', () => {
    expect(round10(1 / 3)).toBe(0.3333333333);
    expect(round10(-1 / 3)).toBe(-0.3333333333);
    expect(PRECISION_DECIMALS).toBe(10);
  });

  it('deja intactos los valores que ya caben en 10 decimales', () => {
    expect(round10(64010.5)).toBe(64010.5);
    expect(round10(0)).toBe(0);
    expect(round10(-7)).toBe(-7);
  });

  it('colapsa a cero por debajo de la resolucion, sin devolver -0', () => {
    expect(round10(1e-11)).toBe(0);
    expect(Object.is(round10(-1e-11), 0)).toBe(true);
    expect(Object.is(round10(-1e-11), -0)).toBe(false);
  });

  it('redondea el empate hacia +infinito, como Math.round', () => {
    expect(round10(5e-11)).toBe(1e-10);
    expect(round10(-5e-11)).toBe(0);
  });

  it('devuelve el valor tal cual cuando escalarlo desbordaria', () => {
    expect(round10(1e300)).toBe(1e300);
    expect(round10(Number.MAX_VALUE)).toBe(Number.MAX_VALUE);
  });

  it('propaga los no finitos sin inventarse un numero', () => {
    expect(round10(Number.NaN)).toBeNaN();
    expect(round10(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
    expect(round10(Number.NEGATIVE_INFINITY)).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe('addPnl', () => {
  it('redondea en cada paso para que la acumulacion no derive', () => {
    expect(addPnl(0.1, 0.2)).toBe(0.3);
  });

  it('sumar 0.1 diez veces da exactamente 1', () => {
    let accumulated = 0;
    for (let i = 0; i < 10; i += 1) {
      accumulated = addPnl(accumulated, 0.1);
    }
    expect(accumulated).toBe(1);
  });

  it('resta igual de bien', () => {
    expect(addPnl(10_000, -1234.5678901234)).toBe(8765.4321098766);
  });
});

describe('bps', () => {
  it('6 bps sobre 10.000 son 6', () => {
    expect(bps(10_000, 6)).toBe(6);
  });

  it('2 bps sobre un nocional de 64.000 son 12,8', () => {
    expect(round10(bps(64_000, 2))).toBe(12.8);
  });

  it('0 bps no cuesta nada', () => {
    expect(bps(64_000, 0)).toBe(0);
  });
});
