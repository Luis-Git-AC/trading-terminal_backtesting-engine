import { describe, expect, it } from 'vitest';
import * as shared from './index.js';

describe('superficie publica de @tt/shared', () => {
  it('expone la version del paquete', () => {
    expect(shared.SHARED_VERSION).toBe('0.1.0');
  });

  it('reexporta las utilidades de timeframe', () => {
    expect(shared.TIMEFRAMES).toEqual(['1m', '15m', '1h']);
    expect(shared.timeframeToMs('1h')).toBe(3_600_000);
    expect(shared.alignTs(3_600_001, '1h')).toBe(3_600_000);
    expect(shared.isAligned(3_600_000, '1h')).toBe(true);
    expect(shared.isTimeframe('15m')).toBe(true);
    expect(shared.expectedCandleCount(0, 3_600_000, '1m')).toBe(60);
    expect(shared.timeframeSchema.safeParse('1m').success).toBe(true);
    expect(() => shared.alignTs(-1, '1m')).toThrow(shared.InvalidTimestampError);
  });

  it('reexporta el dominio de velas', () => {
    expect(shared.CANDLE_SOURCES).toEqual(['rest', 'ws', 'synthetic']);
    expect(shared.candleSourceSchema.safeParse('ws').success).toBe(true);
    expect(shared.candleSchema.safeParse({ t: 0, o: 1, h: 2, l: 0.5, c: 1.5, v: 3 }).success).toBe(
      true,
    );
    expect(
      shared.candleRowToCandle({
        exchange: 'bitget',
        symbol: 'BTCUSDT',
        timeframe: '1m',
        ts: new Date(0),
        open: '1',
        high: '2',
        low: '0.5',
        close: '1.5',
        volume: '3',
        quote_volume: null,
        source: 'rest',
        ingested_at: new Date(0),
      }),
    ).toEqual({ t: 0, o: 1, h: 2, l: 0.5, c: 1.5, v: 3 });
  });

  it('reexporta los codigos de error del contrato', () => {
    expect(shared.ERROR_CODES).toContain('VALIDATION_ERROR');
    expect(shared.ERROR_STATUS.RANGE_TOO_LARGE).toBe(413);
    expect(shared.isErrorCode('INTERNAL')).toBe(true);
  });
});
