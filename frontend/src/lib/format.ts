export const NUMBER_LOCALE = 'en-US';

export function formatNumber(value: number, digits = 2): string {
  return value.toLocaleString(NUMBER_LOCALE, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function formatCount(value: number): string {
  return value.toLocaleString(NUMBER_LOCALE, { maximumFractionDigits: 0 });
}

export function formatPercent(value: number, digits = 2): string {
  return `${formatNumber(value, digits)}%`;
}

export function formatSignedPercent(value: number, digits = 2): string {
  return `${value > 0 ? '+' : ''}${formatPercent(value, digits)}`;
}

export function formatUsd(value: number, digits = 2): string {
  return value.toLocaleString(NUMBER_LOCALE, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}
