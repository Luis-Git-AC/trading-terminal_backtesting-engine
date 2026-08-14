import { describe, expect, it, vi } from 'vitest';
import { timeframeToMs, type Candle } from '@tt/shared';
import { formingTicks, planEmission, readEmitterOptions, runEmitter, seriesOf } from './emitter.js';
import { loadCandleFixture } from './fixtures/seed.js';

const fixture = loadCandleFixture();

describe('readEmitterOptions', () => {
  it('cae en los defaults cuando el entorno esta vacio', () => {
    expect(readEmitterOptions({})).toEqual({
      timeframe: '1m',
      intervalMs: 1000,
      formingTicks: 2,
      bars: 2000,
      seed: 20260814,
    });
  });

  it('lee y convierte lo que trae el entorno', () => {
    expect(
      readEmitterOptions({
        E2E_EMIT_TIMEFRAME: '15m',
        E2E_EMIT_INTERVAL_MS: '250',
        E2E_EMIT_FORMING_TICKS: '0',
        E2E_EMIT_BARS: '10',
        E2E_EMIT_SEED: '7',
      }),
    ).toEqual({ timeframe: '15m', intervalMs: 250, formingTicks: 0, bars: 10, seed: 7 });
  });

  it('rechaza un timeframe que no existe y un intervalo fuera de rango', () => {
    expect(() => readEmitterOptions({ E2E_EMIT_TIMEFRAME: '5m' })).toThrow();
    expect(() => readEmitterOptions({ E2E_EMIT_INTERVAL_MS: '10' })).toThrow();
  });
});

describe('planEmission', () => {
  const series = seriesOf(fixture, '1m');

  it('continua justo despues de la ultima vela del fixture', () => {
    const plan = planEmission({ series, bars: 5, seed: 1 });
    const last = series.candles.at(-1);

    expect(plan).toHaveLength(5);
    expect(plan[0]?.t).toBe((last?.t ?? 0) + timeframeToMs('1m'));
    expect(plan[0]?.o).toBe(last?.c);
  });

  it('emite velas contiguas y alineadas', () => {
    const plan = planEmission({ series, bars: 50, seed: 1 });
    const step = timeframeToMs('1m');

    for (const [index, candle] of plan.entries()) {
      expect(candle.t % step).toBe(0);
      if (index > 0) expect(candle.t - (plan[index - 1]?.t ?? 0)).toBe(step);
      expect(candle.h).toBeGreaterThanOrEqual(Math.max(candle.o, candle.c));
      expect(candle.l).toBeLessThanOrEqual(Math.min(candle.o, candle.c));
    }
  });

  it('es determinista: misma semilla, mismas velas', () => {
    const a = planEmission({ series, bars: 30, seed: 42 });
    const b = planEmission({ series, bars: 30, seed: 42 });
    const c = planEmission({ series, bars: 30, seed: 43 });

    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('arranca en el precio real del fixture, no en un precio de laboratorio', () => {
    const plan = planEmission({ series, bars: 3, seed: 1 });
    expect(plan[0]?.o).toBeGreaterThan(1000);
  });

  it('falla si el fixture no tiene la serie pedida', () => {
    expect(() => seriesOf(fixture, '1h')).toThrow(/no trae ninguna serie de 1h/);
  });
});

describe('formingTicks', () => {
  const candle: Candle = { t: 1_000, o: 100, h: 110, l: 90, c: 105, v: 12 };

  it('no genera nada con 0 pasos', () => {
    expect(formingTicks(candle, 0)).toEqual([]);
  });

  it('genera ticks con el mismo ts y volumen creciente', () => {
    const ticks = formingTicks(candle, 3);

    expect(ticks).toHaveLength(3);
    expect(ticks.every((tick) => tick.t === candle.t)).toBe(true);
    expect(ticks.every((tick) => tick.o === candle.o)).toBe(true);
    expect(ticks.map((tick) => tick.v)).toEqual(
      [...ticks.map((tick) => tick.v)].sort((a, b) => a - b),
    );
    expect(ticks.at(-1)?.v).toBeLessThan(candle.v);
  });

  it('cada tick es una vela coherente y contenida en la definitiva', () => {
    for (const tick of formingTicks(candle, 5)) {
      expect(tick.h).toBeGreaterThanOrEqual(Math.max(tick.o, tick.c));
      expect(tick.l).toBeLessThanOrEqual(Math.min(tick.o, tick.c));
      expect(tick.h).toBeLessThanOrEqual(candle.h);
      expect(tick.l).toBeGreaterThanOrEqual(candle.l);
    }
  });

  it('funciona con velas bajistas', () => {
    const bajista: Candle = { t: 0, o: 105, h: 106, l: 95, c: 100, v: 4 };

    for (const tick of formingTicks(bajista, 4)) {
      expect(tick.c).toBeLessThanOrEqual(bajista.o);
      expect(tick.c).toBeGreaterThanOrEqual(bajista.c);
      expect(tick.h).toBeGreaterThanOrEqual(Math.max(tick.o, tick.c));
    }
  });
});

describe('runEmitter', () => {
  const plan: Candle[] = [
    { t: 0, o: 10, h: 12, l: 9, c: 11, v: 1 },
    { t: 60_000, o: 11, h: 13, l: 10, c: 12, v: 2 },
  ];

  it('publica los ticks en formacion antes del cierre de cada vela', async () => {
    const events: string[] = [];

    const emitted = await runEmitter({
      plan,
      intervalMs: 300,
      formingTicks: 2,
      wait: () => Promise.resolve(),
      publish: (candle, closed) => {
        events.push(`${closed ? 'closed' : 'forming'}@${candle.t}`);
        return Promise.resolve();
      },
      persist: () => Promise.resolve(),
    });

    expect(emitted).toBe(2);
    expect(events).toEqual([
      'forming@0',
      'forming@0',
      'closed@0',
      'forming@60000',
      'forming@60000',
      'closed@60000',
    ]);
  });

  it('persiste solo las velas cerradas y siempre antes de publicarlas', async () => {
    const order: string[] = [];
    const persist = vi.fn((candle: Candle) => {
      order.push(`persist@${candle.t}`);
      return Promise.resolve();
    });

    await runEmitter({
      plan,
      intervalMs: 100,
      formingTicks: 1,
      wait: () => Promise.resolve(),
      persist,
      publish: (candle, closed) => {
        if (closed) order.push(`publish@${candle.t}`);
        return Promise.resolve();
      },
    });

    expect(persist).toHaveBeenCalledTimes(2);
    expect(order).toEqual(['persist@0', 'publish@0', 'persist@60000', 'publish@60000']);
  });

  it('reparte el intervalo entre los ticks y el cierre', async () => {
    const waits: number[] = [];

    await runEmitter({
      plan: [plan[0]!],
      intervalMs: 900,
      formingTicks: 2,
      wait: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
      publish: () => Promise.resolve(),
      persist: () => Promise.resolve(),
    });

    expect(waits).toEqual([300, 300, 300]);
  });

  it('para en cuanto shouldStop devuelve true', async () => {
    const publish = vi.fn(() => Promise.resolve());

    const emitted = await runEmitter({
      plan,
      intervalMs: 10,
      formingTicks: 0,
      shouldStop: () => true,
      wait: () => Promise.resolve(),
      publish,
      persist: () => Promise.resolve(),
    });

    expect(emitted).toBe(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it('avisa de cada vela cerrada por onCandle', async () => {
    const seen: number[] = [];

    await runEmitter({
      plan,
      intervalMs: 10,
      formingTicks: 0,
      wait: () => Promise.resolve(),
      publish: () => Promise.resolve(),
      persist: () => Promise.resolve(),
      onCandle: (candle) => seen.push(candle.t),
    });

    expect(seen).toEqual([0, 60_000]);
  });
});
