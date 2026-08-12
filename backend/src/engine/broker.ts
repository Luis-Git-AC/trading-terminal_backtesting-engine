import type { Candle } from '@tt/shared';
import { bps, round10 } from './num.js';
import type { ExecConfig, ExitReason, Position, Side, Trade } from './types.js';

export const REJECTION_REASONS = [
  'zero-stop-distance',
  'stop-on-wrong-side',
  'non-positive-quantity',
  'invalid-price',
] as const;

export type RejectionReason = (typeof REJECTION_REASONS)[number];

export interface OpenPositionRequest {
  readonly side: Side;
  readonly index: number;
  readonly ts: number;
  readonly referencePrice: number;
  readonly stopPrice: number;
  readonly equity: number;
  readonly exec: ExecConfig;
  readonly takeProfitR?: number;
}

export type OpenPositionResult =
  | { readonly ok: true; readonly position: Position }
  | { readonly ok: false; readonly reason: RejectionReason };

export interface ClosePositionRequest {
  readonly position: Position;
  readonly exitPrice: number;
  readonly exitTs: number;
  readonly reason: ExitReason;
  readonly exec: ExecConfig;
  readonly seq: number;
}

export interface ExitCheck {
  readonly reason: Extract<ExitReason, 'stop' | 'take-profit'>;
  readonly price: number;
}

export function applySlippage(price: number, side: Side, direction: 'entry' | 'exit', exec: ExecConfig): number {
  const buying = (side === 'long' && direction === 'entry') || (side === 'short' && direction === 'exit');
  const offset = bps(price, exec.slippageBps);
  return buying ? price + offset : price - offset;
}

export function feeFor(price: number, qty: number, exec: ExecConfig): number {
  return bps(price * qty, exec.feeBps);
}

export function takeProfitPriceFor(
  side: Side,
  entryPrice: number,
  stopPrice: number,
  takeProfitR: number | undefined,
): number | null {
  if (takeProfitR === undefined || takeProfitR <= 0) {
    return null;
  }
  const riskPerUnit = Math.abs(entryPrice - stopPrice);
  return side === 'long'
    ? entryPrice + takeProfitR * riskPerUnit
    : entryPrice - takeProfitR * riskPerUnit;
}

export function openPosition(request: OpenPositionRequest): OpenPositionResult {
  const { side, referencePrice, stopPrice, equity, exec } = request;

  if (
    !Number.isFinite(referencePrice) ||
    !Number.isFinite(stopPrice) ||
    referencePrice <= 0 ||
    stopPrice <= 0
  ) {
    return { ok: false, reason: 'invalid-price' };
  }

  const entryPrice = applySlippage(referencePrice, side, 'entry', exec);
  const riskPerUnit = Math.abs(entryPrice - stopPrice);

  if (riskPerUnit === 0) {
    return { ok: false, reason: 'zero-stop-distance' };
  }
  if (side === 'long' ? stopPrice >= entryPrice : stopPrice <= entryPrice) {
    return { ok: false, reason: 'stop-on-wrong-side' };
  }

  const qty = (equity * exec.riskPerTradePct) / 100 / riskPerUnit;
  if (!Number.isFinite(qty) || qty <= 0) {
    return { ok: false, reason: 'non-positive-quantity' };
  }

  return {
    ok: true,
    position: {
      side,
      entryIndex: request.index,
      entryTs: request.ts,
      entryPrice,
      qty,
      stopPrice,
      takeProfitPrice: takeProfitPriceFor(side, entryPrice, stopPrice, request.takeProfitR),
      riskQuote: qty * riskPerUnit,
      entryFee: feeFor(entryPrice, qty, exec),
      maeQuote: 0,
      mfeQuote: 0,
    },
  };
}

export function updateExcursions(position: Position, bar: Candle): void {
  const adverse =
    position.side === 'long' ? position.entryPrice - bar.l : bar.h - position.entryPrice;
  const favorable =
    position.side === 'long' ? bar.h - position.entryPrice : position.entryPrice - bar.l;

  const adverseQuote = adverse * position.qty;
  const favorableQuote = favorable * position.qty;

  if (adverseQuote > position.maeQuote) {
    position.maeQuote = adverseQuote;
  }
  if (favorableQuote > position.mfeQuote) {
    position.mfeQuote = favorableQuote;
  }
}

export function checkExits(position: Position, bar: Candle): ExitCheck | null {
  const stopHit =
    position.side === 'long' ? bar.l <= position.stopPrice : bar.h >= position.stopPrice;

  if (stopHit) {
    return { reason: 'stop', price: position.stopPrice };
  }

  const target = position.takeProfitPrice;
  if (target === null) {
    return null;
  }

  const targetHit = position.side === 'long' ? bar.h >= target : bar.l <= target;
  return targetHit ? { reason: 'take-profit', price: target } : null;
}

export function closePosition(request: ClosePositionRequest): Trade {
  const { position, exitPrice, exec } = request;
  const fillPrice = applySlippage(exitPrice, position.side, 'exit', exec);

  const grossPerUnit =
    position.side === 'long' ? fillPrice - position.entryPrice : position.entryPrice - fillPrice;
  const gross = grossPerUnit * position.qty;
  const exitFee = feeFor(fillPrice, position.qty, exec);
  const fees = position.entryFee + exitFee;
  const pnlQuote = gross - fees;

  return {
    seq: request.seq,
    side: position.side,
    entryTs: position.entryTs,
    entryPrice: round10(position.entryPrice),
    exitTs: request.exitTs,
    exitPrice: round10(fillPrice),
    qty: round10(position.qty),
    fees: round10(fees),
    pnlQuote: round10(pnlQuote),
    pnlR: round10(pnlQuote / position.riskQuote),
    exitReason: request.reason,
    maeR: round10(position.maeQuote / position.riskQuote),
    mfeR: round10(position.mfeQuote / position.riskQuote),
  };
}
