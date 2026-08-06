import { describe, expect, it } from 'vitest';
import {
  InvalidTimestampError,
  TIMEFRAMES,
  alignTs,
  expectedCandleCount,
  isAligned,
  isTimeframe,
  timeframeSchema,
  timeframeToMs,
} from './timeframe.js';

const HOUR = 3_600_000;
const MINUTE = 60_000;

describe('TIMEFRAMES y guardas', () => {
  it('expone exactamente los tres timeframes del MVP', () => {
    expect(TIMEFRAMES).toEqual(['1m', '15m', '1h']);
  });

  it('isTimeframe acepta los validos y rechaza todo lo demas', () => {
    expect(isTimeframe('1m')).toBe(true);
    expect(isTimeframe('15m')).toBe(true);
    expect(isTimeframe('1h')).toBe(true);
    expect(isTimeframe('4h')).toBe(false);
    expect(isTimeframe('1M')).toBe(false);
    expect(isTimeframe(60)).toBe(false);
    expect(isTimeframe(null)).toBe(false);
    expect(isTimeframe(undefined)).toBe(false);
  });

  it('timeframeSchema valida con Zod', () => {
    expect(timeframeSchema.safeParse('15m').success).toBe(true);
    expect(timeframeSchema.safeParse('4h').success).toBe(false);
  });
});

describe('timeframeToMs', () => {
  it('devuelve la duracion en milisegundos', () => {
    expect(timeframeToMs('1m')).toBe(60_000);
    expect(timeframeToMs('15m')).toBe(900_000);
    expect(timeframeToMs('1h')).toBe(3_600_000);
  });
});

describe('alignTs', () => {
  it('deja intacto un timestamp ya alineado', () => {
    const exact = Date.UTC(2026, 0, 1, 12, 0, 0);
    expect(alignTs(exact, '1h')).toBe(exact);
    expect(alignTs(exact, '15m')).toBe(exact);
    expect(alignTs(exact, '1m')).toBe(exact);
  });

  it('trunca hacia atras, nunca hacia adelante', () => {
    const ts = Date.UTC(2026, 0, 1, 12, 34, 56, 789);

    expect(alignTs(ts, '1m')).toBe(Date.UTC(2026, 0, 1, 12, 34, 0, 0));
    expect(alignTs(ts, '15m')).toBe(Date.UTC(2026, 0, 1, 12, 30, 0, 0));
    expect(alignTs(ts, '1h')).toBe(Date.UTC(2026, 0, 1, 12, 0, 0, 0));
  });

  it('es idempotente', () => {
    const ts = Date.UTC(2026, 5, 15, 8, 47, 12, 345);
    const once = alignTs(ts, '15m');

    expect(alignTs(once, '15m')).toBe(once);
  });

  it('no se ve afectado por los cambios de hora locales: la aritmetica es UTC pura', () => {
    const euDstChange = Date.parse('2026-03-29T01:30:00.000Z');
    const usDstChange = Date.parse('2026-03-08T07:30:00.000Z');

    expect(alignTs(euDstChange, '1h')).toBe(Date.parse('2026-03-29T01:00:00.000Z'));
    expect(alignTs(usDstChange, '1h')).toBe(Date.parse('2026-03-08T07:00:00.000Z'));
    expect(new Date(alignTs(euDstChange, '1h')).toISOString()).toBe('2026-03-29T01:00:00.000Z');
  });

  it('alinea el epoch 0 a si mismo', () => {
    expect(alignTs(0, '1h')).toBe(0);
  });

  it('rechaza timestamps negativos', () => {
    expect(() => alignTs(-1, '1h')).toThrow(InvalidTimestampError);
    expect(() => alignTs(-HOUR, '1h')).toThrow(/no negativo/);
  });

  it('rechaza timestamps no enteros o no finitos', () => {
    expect(() => alignTs(1.5, '1m')).toThrow(InvalidTimestampError);
    expect(() => alignTs(Number.NaN, '1m')).toThrow(InvalidTimestampError);
    expect(() => alignTs(Number.POSITIVE_INFINITY, '1m')).toThrow(InvalidTimestampError);
    expect(() => alignTs(Number.MAX_SAFE_INTEGER + 2, '1m')).toThrow(InvalidTimestampError);
  });

  it('el error expone el valor rechazado', () => {
    try {
      alignTs(-42, '1m');
      expect.unreachable('alignTs deberia haber lanzado');
    } catch (error) {
      if (!(error instanceof InvalidTimestampError)) throw error;
      expect(error.value).toBe(-42);
      expect(error.name).toBe('InvalidTimestampError');
    }
  });
});

describe('isAligned', () => {
  it('distingue alineado de desalineado', () => {
    const onTheHour = Date.UTC(2026, 0, 1, 9, 0, 0);

    expect(isAligned(onTheHour, '1h')).toBe(true);
    expect(isAligned(onTheHour + 1, '1h')).toBe(false);
    expect(isAligned(onTheHour + 15 * MINUTE, '15m')).toBe(true);
    expect(isAligned(onTheHour + 15 * MINUTE, '1h')).toBe(false);
  });

  it('rechaza timestamps invalidos igual que alignTs', () => {
    expect(() => isAligned(-1, '1m')).toThrow(InvalidTimestampError);
  });
});

describe('expectedCandleCount', () => {
  it('un dia completo en 1h son 24 velas', () => {
    const from = Date.parse('2026-01-01T00:00:00.000Z');
    const to = Date.parse('2026-01-02T00:00:00.000Z');

    expect(expectedCandleCount(from, to, '1h')).toBe(24);
  });

  it('una hora completa en 1m son 60 velas', () => {
    const from = Date.parse('2026-01-01T00:00:00.000Z');
    const to = Date.parse('2026-01-01T01:00:00.000Z');

    expect(expectedCandleCount(from, to, '1m')).toBe(60);
  });

  it('un dia completo en 15m son 96 velas', () => {
    const from = Date.parse('2026-01-01T00:00:00.000Z');
    const to = Date.parse('2026-01-02T00:00:00.000Z');

    expect(expectedCandleCount(from, to, '15m')).toBe(96);
  });

  it('cuenta el rango como [from, to): la vela de cierre no entra', () => {
    const from = Date.parse('2026-01-01T00:00:00.000Z');

    expect(expectedCandleCount(from, from + HOUR, '1h')).toBe(1);
    expect(expectedCandleCount(from, from + HOUR + 1, '1h')).toBe(2);
    expect(expectedCandleCount(from, from, '1h')).toBe(0);
  });

  it('con extremos desalineados cuenta solo las aperturas dentro del rango', () => {
    const hour = Date.parse('2026-01-01T00:00:00.000Z');

    expect(expectedCandleCount(hour + 1, hour + HOUR, '1h')).toBe(0);
    expect(expectedCandleCount(hour + 1, hour + HOUR + 1, '1h')).toBe(1);
    expect(expectedCandleCount(hour + MINUTE, hour + HOUR, '15m')).toBe(3);
  });

  it('devuelve 0 si el rango esta invertido', () => {
    const from = Date.parse('2026-01-02T00:00:00.000Z');
    const to = Date.parse('2026-01-01T00:00:00.000Z');

    expect(expectedCandleCount(from, to, '1h')).toBe(0);
  });

  it('rechaza extremos invalidos', () => {
    expect(() => expectedCandleCount(-1, 0, '1h')).toThrow(InvalidTimestampError);
    expect(() => expectedCandleCount(0, -1, '1h')).toThrow(InvalidTimestampError);
  });
});
