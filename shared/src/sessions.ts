/**
 * Calendario semanal de sesion, declarado como dato y en UTC. Los perpetuos TradFi cotizan 24/7
 * en el exchange, pero su subyacente cierra: estos tramos son los que se pueden excluir.
 *
 * shortcut: sin festivos, añadir calendario si el sesgo se nota
 */

export const ASSET_CLASSES = ['crypto', 'metals', 'energy'] as const;

export type AssetClass = (typeof ASSET_CLASSES)[number];

/** Minuto de la semana, contado desde el domingo 00:00 UTC. */
export const MINUTES_PER_WEEK = 7 * 24 * 60;

export interface SessionWindow {
  /** Minuto de la semana en el que abre, inclusive. */
  readonly from: number;
  /** Minuto de la semana en el que cierra, exclusive. Puede ser menor que `from`: la ventana cruza el domingo. */
  readonly to: number;
}

function weekMinute(day: number, hour: number, minute = 0): number {
  return day * 24 * 60 + hour * 60 + minute;
}

const DAY = { sunday: 0, monday: 1, friday: 5 } as const;

/**
 * Horarios reales de los subyacentes (CME Globex), en UTC y sin horario de verano:
 * de domingo 22:00 a viernes 21:00, con la pausa diaria de mantenimiento de 21:00 a 22:00.
 */
const TRADFI_WINDOWS: readonly SessionWindow[] = [
  { from: weekMinute(DAY.sunday, 22), to: weekMinute(DAY.monday, 21) },
  { from: weekMinute(DAY.monday, 22), to: weekMinute(DAY.monday + 1, 21) },
  { from: weekMinute(DAY.monday + 1, 22), to: weekMinute(DAY.monday + 2, 21) },
  { from: weekMinute(DAY.monday + 2, 22), to: weekMinute(DAY.monday + 3, 21) },
  { from: weekMinute(DAY.monday + 3, 22), to: weekMinute(DAY.friday, 21) },
];

const ALWAYS_OPEN: readonly SessionWindow[] = [{ from: 0, to: MINUTES_PER_WEEK }];

export const SESSION_CALENDARS: Record<AssetClass, readonly SessionWindow[]> = {
  crypto: ALWAYS_OPEN,
  metals: TRADFI_WINDOWS,
  energy: TRADFI_WINDOWS,
};

/**
 * Clase de activo por simbolo. Lo que no esta aqui es crypto, que cotiza 24/7:
 * un simbolo nuevo nunca queda excluido por error.
 */
export const ASSET_CLASS_BY_SYMBOL: Record<string, AssetClass> = {
  XAUUSDT: 'metals',
  XAGUSDT: 'metals',
  XPTUSDT: 'metals',
  XPDUSDT: 'metals',
  CLUSDT: 'energy',
  BZUSDT: 'energy',
  NATGASUSDT: 'energy',
};

export function assetClassOf(symbol: string): AssetClass {
  return ASSET_CLASS_BY_SYMBOL[symbol] ?? 'crypto';
}

/** Minuto de la semana de un timestamp. El epoch (1970-01-01) fue jueves. */
export function weekMinuteOf(ts: number): number {
  const minutes = Math.floor(ts / 60_000);
  const offset = weekMinute(DAY.monday + 3, 0); // el epoch cae en jueves
  return (((minutes + offset) % MINUTES_PER_WEEK) + MINUTES_PER_WEEK) % MINUTES_PER_WEEK;
}

export function isInSession(ts: number, windows: readonly SessionWindow[]): boolean {
  const minute = weekMinuteOf(ts);

  return windows.some((window) =>
    window.from <= window.to
      ? minute >= window.from && minute < window.to
      : minute >= window.from || minute < window.to,
  );
}

export function isSymbolInSession(ts: number, symbol: string): boolean {
  return isInSession(ts, SESSION_CALENDARS[assetClassOf(symbol)]);
}
