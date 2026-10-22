import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MINUTES_PER_WEEK,
  SESSION_CALENDARS,
  assetClassOf,
  isInSession,
  isSymbolInSession,
  weekMinuteOf,
} from './sessions.js';

const SOURCE = readFileSync(new URL('./sessions.ts', import.meta.url), 'utf8');

function at(iso: string): number {
  return Date.parse(iso);
}

describe('calendario de sesion: pureza', () => {
  it('el modulo no usa reloj, aleatoriedad, entorno ni red', () => {
    for (const pattern of [
      /\bDate\s*\.\s*now\s*\(/,
      /\bnew\s+Date\s*\(/,
      /\bMath\s*\.\s*random\s*\(/,
      /\bprocess\s*\.\s*env\b/,
      /\bfetch\s*\(/,
      /\bInt[lL]\b/,
    ]) {
      expect(SOURCE).not.toMatch(pattern);
    }
  });

  it('mismos argumentos, mismo resultado, 1000 veces', () => {
    const ts = at('2026-10-17T12:00:00Z');
    const results = new Set(
      Array.from({ length: 1000 }, () => isInSession(ts, SESSION_CALENDARS.metals)),
    );

    expect(results.size).toBe(1);
    expect([...results]).toEqual([false]);
  });
});

describe('minuto de la semana', () => {
  it('el epoch cae en jueves a las 00:00 UTC', () => {
    expect(weekMinuteOf(0)).toBe(4 * 24 * 60);
  });

  it('el domingo 00:00 UTC es el minuto 0 y el sabado 23:59 el ultimo', () => {
    expect(weekMinuteOf(at('2026-10-18T00:00:00Z'))).toBe(0);
    expect(weekMinuteOf(at('2026-10-17T23:59:00Z'))).toBe(MINUTES_PER_WEEK - 1);
  });

  it('nunca sale del rango, ni con timestamps anteriores al epoch', () => {
    for (const ts of [-1, -86_400_000, 0, 1, 1_792_699_532_471]) {
      const minute = weekMinuteOf(ts);
      expect(minute).toBeGreaterThanOrEqual(0);
      expect(minute).toBeLessThan(MINUTES_PER_WEEK);
    }
  });
});

describe('sesion de los perpetuos TradFi', () => {
  const metals = SESSION_CALENDARS.metals;

  it('el fin de semana esta fuera de sesion', () => {
    expect(isInSession(at('2026-10-17T00:00:00Z'), metals)).toBe(false); // sabado
    expect(isInSession(at('2026-10-17T12:00:00Z'), metals)).toBe(false);
    expect(isInSession(at('2026-10-18T21:00:00Z'), metals)).toBe(false); // domingo antes de abrir
  });

  it('abre el domingo a las 22:00 y cierra el viernes a las 21:00 UTC', () => {
    expect(isInSession(at('2026-10-18T21:59:00Z'), metals)).toBe(false);
    expect(isInSession(at('2026-10-18T22:00:00Z'), metals)).toBe(true);
    expect(isInSession(at('2026-10-16T20:59:00Z'), metals)).toBe(true); // viernes
    expect(isInSession(at('2026-10-16T21:00:00Z'), metals)).toBe(false);
  });

  it('respeta la pausa diaria de mantenimiento de 21:00 a 22:00', () => {
    expect(isInSession(at('2026-10-20T20:59:00Z'), metals)).toBe(true); // martes
    expect(isInSession(at('2026-10-20T21:30:00Z'), metals)).toBe(false);
    expect(isInSession(at('2026-10-20T22:00:00Z'), metals)).toBe(true);
  });

  it('cada minuto de la semana cae en una sola ventana', () => {
    const open = Array.from({ length: MINUTES_PER_WEEK }, (_, minute) =>
      metals.filter((window) =>
        window.from <= window.to
          ? minute >= window.from && minute < window.to
          : minute >= window.from || minute < window.to,
      ).length,
    );

    expect(Math.max(...open)).toBe(1);
    // 5 sesiones de 23 h: 6900 minutos abiertos de los 10080 de la semana.
    expect(open.filter((count) => count === 1)).toHaveLength(5 * 23 * 60);
  });
});

describe('clase de activo por simbolo', () => {
  it('los metales y la energia son TradFi; lo demas es crypto 24/7', () => {
    expect(assetClassOf('XAUUSDT')).toBe('metals');
    expect(assetClassOf('CLUSDT')).toBe('energy');
    expect(assetClassOf('BTCUSDT')).toBe('crypto');
    expect(assetClassOf('LO-QUE-SEA')).toBe('crypto');
  });

  it('una serie crypto esta siempre en sesion, tambien en sabado', () => {
    for (const iso of ['2026-10-17T00:00:00Z', '2026-10-17T21:30:00Z', '2026-10-20T12:00:00Z']) {
      expect(isSymbolInSession(at(iso), 'BTCUSDT')).toBe(true);
    }
  });

  it('el oro no esta en sesion el sabado pero si el martes', () => {
    expect(isSymbolInSession(at('2026-10-17T12:00:00Z'), 'XAUUSDT')).toBe(false);
    expect(isSymbolInSession(at('2026-10-20T12:00:00Z'), 'XAUUSDT')).toBe(true);
  });
});
