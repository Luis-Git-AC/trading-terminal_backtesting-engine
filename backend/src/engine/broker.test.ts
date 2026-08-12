import type { Candle } from '@tt/shared';
import { describe, expect, it } from 'vitest';
import {
  applySlippage,
  checkExits,
  closePosition,
  openPosition,
  takeProfitPriceFor,
  updateExcursions,
} from './broker.js';
import type { ExecConfig, Position } from './types.js';

const FREE: ExecConfig = {
  initialCapital: 10_000,
  riskPerTradePct: 1,
  feeBps: 0,
  slippageBps: 0,
  fillModel: 'next-open',
};

const COSTLY: ExecConfig = {
  initialCapital: 10_000,
  riskPerTradePct: 1,
  feeBps: 10,
  slippageBps: 100,
  fillModel: 'next-open',
};

function bar(values: { h: number; l: number; c?: number; o?: number; t?: number }): Candle {
  return {
    t: values.t ?? 0,
    o: values.o ?? values.l,
    h: values.h,
    l: values.l,
    c: values.c ?? values.h,
    v: 1,
  };
}

function openOrThrow(...args: Parameters<typeof openPosition>): Position {
  const result = openPosition(...args);
  if (!result.ok) {
    throw new Error(`Se esperaba una apertura correcta, llego ${result.reason}`);
  }
  return result.position;
}

describe('applySlippage', () => {
  it('siempre es adverso: se compra mas caro y se vende mas barato', () => {
    expect(applySlippage(100, 'long', 'entry', COSTLY)).toBe(101);
    expect(applySlippage(100, 'long', 'exit', COSTLY)).toBe(99);
    expect(applySlippage(100, 'short', 'entry', COSTLY)).toBe(99);
    expect(applySlippage(100, 'short', 'exit', COSTLY)).toBe(101);
  });

  it('con 0 bps no mueve el precio', () => {
    expect(applySlippage(100, 'long', 'entry', FREE)).toBe(100);
  });
});

describe('openPosition', () => {
  it('dimensiona la posicion para arriesgar exactamente el % configurado', () => {
    const position = openOrThrow({
      side: 'long',
      index: 0,
      ts: 0,
      referencePrice: 100,
      stopPrice: 91,
      equity: 10_000,
      exec: COSTLY,
    });
    expect(position.entryPrice).toBe(101);
    expect(position.qty).toBe(10);
    expect(position.riskQuote).toBe(100);
    expect(position.entryFee).toBeCloseTo(1.01, 10);
  });

  it('el riesgo se mide contra el precio ya deslizado, no contra el de referencia', () => {
    const position = openOrThrow({
      side: 'long',
      index: 0,
      ts: 0,
      referencePrice: 100,
      stopPrice: 91,
      equity: 10_000,
      exec: COSTLY,
    });
    expect(position.riskQuote).toBe(position.qty * Math.abs(position.entryPrice - 91));
  });

  it('el short se dimensiona igual', () => {
    const position = openOrThrow({
      side: 'short',
      index: 0,
      ts: 0,
      referencePrice: 100,
      stopPrice: 109,
      equity: 10_000,
      exec: COSTLY,
    });
    expect(position.entryPrice).toBe(99);
    expect(position.qty).toBe(10);
    expect(position.riskQuote).toBe(100);
  });

  it('distancia al stop 0 devuelve rechazo tipado, sin excepcion ni posicion', () => {
    const result = openPosition({
      side: 'long',
      index: 0,
      ts: 0,
      referencePrice: 100,
      stopPrice: 100,
      equity: 10_000,
      exec: FREE,
    });
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.reason).toBe('zero-stop-distance');
  });

  it('un stop del lado equivocado se rechaza', () => {
    const long = openPosition({
      side: 'long',
      index: 0,
      ts: 0,
      referencePrice: 100,
      stopPrice: 110,
      equity: 10_000,
      exec: FREE,
    });
    expect(long.ok ? null : long.reason).toBe('stop-on-wrong-side');

    const short = openPosition({
      side: 'short',
      index: 0,
      ts: 0,
      referencePrice: 100,
      stopPrice: 90,
      equity: 10_000,
      exec: FREE,
    });
    expect(short.ok ? null : short.reason).toBe('stop-on-wrong-side');
  });

  it('un equity de 0 no abre una posicion fantasma', () => {
    const result = openPosition({
      side: 'long',
      index: 0,
      ts: 0,
      referencePrice: 100,
      stopPrice: 90,
      equity: 0,
      exec: FREE,
    });
    expect(result.ok ? null : result.reason).toBe('non-positive-quantity');
  });

  it('rechaza precios no finitos o no positivos', () => {
    const nan = openPosition({
      side: 'long',
      index: 0,
      ts: 0,
      referencePrice: Number.NaN,
      stopPrice: 90,
      equity: 10_000,
      exec: FREE,
    });
    expect(nan.ok ? null : nan.reason).toBe('invalid-price');

    const zero = openPosition({
      side: 'long',
      index: 0,
      ts: 0,
      referencePrice: 0,
      stopPrice: 90,
      equity: 10_000,
      exec: FREE,
    });
    expect(zero.ok ? null : zero.reason).toBe('invalid-price');
  });
});

describe('takeProfitPriceFor', () => {
  it('coloca el objetivo a N multiplos de R del lado correcto', () => {
    expect(takeProfitPriceFor('long', 101, 91, 2)).toBe(121);
    expect(takeProfitPriceFor('short', 99, 109, 2)).toBe(79);
  });

  it('sin takeProfitR no hay objetivo', () => {
    expect(takeProfitPriceFor('long', 101, 91, undefined)).toBeNull();
    expect(takeProfitPriceFor('long', 101, 91, 0)).toBeNull();
  });
});

describe('closePosition', () => {
  it('long: el PnL neto coincide con el calculado a mano', () => {
    const position = openOrThrow({
      side: 'long',
      index: 0,
      ts: 1_000,
      referencePrice: 100,
      stopPrice: 91,
      equity: 10_000,
      exec: COSTLY,
    });
    const trade = closePosition({
      position,
      exitPrice: 121,
      exitTs: 2_000,
      reason: 'take-profit',
      exec: COSTLY,
      seq: 1,
    });

    expect(trade.exitPrice).toBe(119.79);
    expect(trade.fees).toBeCloseTo(2.2079, 10);
    expect(trade.pnlQuote).toBeCloseTo(185.6921, 10);
    expect(trade.pnlR).toBeCloseTo(1.856921, 10);
    expect(trade.side).toBe('long');
    expect(trade.exitReason).toBe('take-profit');
    expect(trade.entryTs).toBe(1_000);
    expect(trade.exitTs).toBe(2_000);
  });

  it('short: el PnL neto coincide con el calculado a mano', () => {
    const position = openOrThrow({
      side: 'short',
      index: 0,
      ts: 1_000,
      referencePrice: 100,
      stopPrice: 109,
      equity: 10_000,
      exec: COSTLY,
    });
    const trade = closePosition({
      position,
      exitPrice: 79,
      exitTs: 2_000,
      reason: 'take-profit',
      exec: COSTLY,
      seq: 1,
    });

    expect(trade.exitPrice).toBe(79.79);
    expect(trade.fees).toBeCloseTo(1.7879, 10);
    expect(trade.pnlQuote).toBeCloseTo(190.3121, 10);
    expect(trade.pnlR).toBeCloseTo(1.903121, 10);
  });

  it('un trade que sale exactamente en el stop da pnlR = -1 cuando no hay costes', () => {
    const position = openOrThrow({
      side: 'long',
      index: 0,
      ts: 0,
      referencePrice: 100,
      stopPrice: 90,
      equity: 10_000,
      exec: FREE,
    });
    const trade = closePosition({
      position,
      exitPrice: 90,
      exitTs: 1,
      reason: 'stop',
      exec: FREE,
      seq: 1,
    });
    expect(trade.pnlR).toBe(-1);
    expect(trade.pnlQuote).toBe(-100);
  });

  it('con costes, ese mismo trade pierde algo mas de 1R', () => {
    const position = openOrThrow({
      side: 'long',
      index: 0,
      ts: 0,
      referencePrice: 100,
      stopPrice: 91,
      equity: 10_000,
      exec: COSTLY,
    });
    const trade = closePosition({
      position,
      exitPrice: 91,
      exitTs: 1,
      reason: 'stop',
      exec: COSTLY,
      seq: 1,
    });
    expect(trade.pnlR).toBeLessThan(-1);
    expect(trade.pnlQuote).toBeCloseTo(-111.0109, 10);
  });

  it('traslada MAE y MFE a multiplos de R', () => {
    const position = openOrThrow({
      side: 'long',
      index: 0,
      ts: 0,
      referencePrice: 100,
      stopPrice: 90,
      equity: 10_000,
      exec: FREE,
    });
    updateExcursions(position, bar({ h: 115, l: 95 }));
    const trade = closePosition({
      position,
      exitPrice: 110,
      exitTs: 1,
      reason: 'signal',
      exec: FREE,
      seq: 1,
    });
    expect(trade.maeR).toBe(0.5);
    expect(trade.mfeR).toBe(1.5);
  });
});

describe('updateExcursions', () => {
  it('en largo mide lo peor con el low y lo mejor con el high', () => {
    const position = openOrThrow({
      side: 'long',
      index: 0,
      ts: 0,
      referencePrice: 100,
      stopPrice: 90,
      equity: 10_000,
      exec: FREE,
    });
    updateExcursions(position, bar({ h: 105, l: 98 }));
    expect(position.maeQuote).toBe(20);
    expect(position.mfeQuote).toBe(50);
  });

  it('en corto se invierten', () => {
    const position = openOrThrow({
      side: 'short',
      index: 0,
      ts: 0,
      referencePrice: 100,
      stopPrice: 110,
      equity: 10_000,
      exec: FREE,
    });
    updateExcursions(position, bar({ h: 102, l: 95 }));
    expect(position.maeQuote).toBe(20);
    expect(position.mfeQuote).toBe(50);
  });

  it('solo empeora, nunca retrocede', () => {
    const position = openOrThrow({
      side: 'long',
      index: 0,
      ts: 0,
      referencePrice: 100,
      stopPrice: 90,
      equity: 10_000,
      exec: FREE,
    });
    updateExcursions(position, bar({ h: 120, l: 80 }));
    updateExcursions(position, bar({ h: 101, l: 99 }));
    expect(position.maeQuote).toBe(200);
    expect(position.mfeQuote).toBe(200);
  });

  it('una barra que nunca va en contra deja el MAE en 0', () => {
    const position = openOrThrow({
      side: 'long',
      index: 0,
      ts: 0,
      referencePrice: 100,
      stopPrice: 90,
      equity: 10_000,
      exec: FREE,
    });
    updateExcursions(position, bar({ h: 110, l: 101 }));
    expect(position.maeQuote).toBe(0);
  });
});

describe('checkExits', () => {
  const longPosition = (): Position =>
    openOrThrow({
      side: 'long',
      index: 0,
      ts: 0,
      referencePrice: 100,
      stopPrice: 90,
      equity: 10_000,
      exec: FREE,
      takeProfitR: 2,
    });

  it('el objetivo se coloca a 2R por encima de la entrada', () => {
    expect(longPosition().takeProfitPrice).toBe(120);
  });

  it('stop y take-profit en la misma barra: gana el stop', () => {
    expect(checkExits(longPosition(), bar({ h: 125, l: 85 }))).toEqual({
      reason: 'stop',
      price: 90,
    });
  });

  it('sale al precio del stop, no al cierre de la barra', () => {
    const exit = checkExits(longPosition(), bar({ h: 99, l: 85, c: 86 }));
    expect(exit?.price).toBe(90);
  });

  it('sale al precio del objetivo, no al cierre de la barra', () => {
    const exit = checkExits(longPosition(), bar({ h: 130, l: 95, c: 128 }));
    expect(exit).toEqual({ reason: 'take-profit', price: 120 });
  });

  it('una barra que no toca ninguno de los dos no cierra nada', () => {
    expect(checkExits(longPosition(), bar({ h: 110, l: 95 }))).toBeNull();
  });

  it('tocar el stop justo en el borde cuenta como tocado', () => {
    expect(checkExits(longPosition(), bar({ h: 110, l: 90 }))?.reason).toBe('stop');
  });

  it('en corto el stop esta arriba y el objetivo abajo', () => {
    const position = openOrThrow({
      side: 'short',
      index: 0,
      ts: 0,
      referencePrice: 100,
      stopPrice: 110,
      equity: 10_000,
      exec: FREE,
      takeProfitR: 2,
    });
    expect(position.takeProfitPrice).toBe(80);
    expect(checkExits(position, bar({ h: 115, l: 75 }))).toEqual({ reason: 'stop', price: 110 });
    expect(checkExits(position, bar({ h: 105, l: 75 }))).toEqual({
      reason: 'take-profit',
      price: 80,
    });
  });

  it('sin objetivo solo puede cerrar el stop', () => {
    const position = openOrThrow({
      side: 'long',
      index: 0,
      ts: 0,
      referencePrice: 100,
      stopPrice: 90,
      equity: 10_000,
      exec: FREE,
    });
    expect(position.takeProfitPrice).toBeNull();
    expect(checkExits(position, bar({ h: 500, l: 95 }))).toBeNull();
  });
});
