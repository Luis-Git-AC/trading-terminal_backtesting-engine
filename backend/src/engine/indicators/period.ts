export class InvalidPeriodError extends Error {
  override readonly name = 'InvalidPeriodError';
  readonly indicator: string;
  readonly period: number;

  constructor(indicator: string, period: number) {
    super(`Periodo invalido para ${indicator}: ${period}. Se espera un entero >= 1.`);
    this.indicator = indicator;
    this.period = period;
  }
}

export function assertPeriod(indicator: string, period: number): void {
  if (!Number.isInteger(period) || period < 1) {
    throw new InvalidPeriodError(indicator, period);
  }
}
