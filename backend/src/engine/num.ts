export const PRECISION_DECIMALS = 10;

const SCALE = 1e10;

const BPS_DENOMINATOR = 10_000;

export function round10(value: number): number {
  if (!Number.isFinite(value)) {
    return value;
  }
  const scaled = value * SCALE;
  if (!Number.isFinite(scaled)) {
    return value;
  }
  const rounded = Math.round(scaled) / SCALE;
  return rounded === 0 ? 0 : rounded;
}

export function addPnl(accumulated: number, delta: number): number {
  return round10(accumulated + delta);
}

export function bps(value: number, basisPoints: number): number {
  return (value * basisPoints) / BPS_DENOMINATOR;
}
