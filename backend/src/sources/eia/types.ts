import { z } from 'zod';
import { atEasternTime, nextWeekday } from '../eastern-time.js';

export const EIA_SOURCE_ID = 'eia';
export const EIA_STOCKS_PATH = '/v2/petroleum/stoc/wstk/data/';

/** Tope de `length` de la API v2. */
export const EIA_PAGE_LENGTH = 5000;

/** Tipo de evento con el que entra el informe semanal en `market_events`. */
export const EIA_REPORT_EVENT_TYPE = 'eia-wpsr';

export const EIA_EVENT_TAGS = ['oil'] as const;

/**
 * El Weekly Petroleum Status Report cubre la semana que cierra el viernes y se publica el
 * miercoles siguiente a las 10:30 de Nueva York.
 */
export const EIA_RELEASE_WEEKDAY = 3;
export const EIA_RELEASE_HOUR_ET = 10;
export const EIA_RELEASE_MINUTE_ET = 30;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'fecha YYYY-MM-DD');

export const eiaRowSchema = z.object({
  period: isoDate,
  series: z.string(),
  /**
   * La API v2 lo sirve **entre comillas** (`"424134"`), aunque algun endpoint devuelva numero. Se
   * aceptan los dos y la conversion la hace `numericValue`. Un dato ausente llega como `null`.
   */
  value: z.union([z.string(), z.number()]).nullable(),
  units: z.string().optional(),
  'series-description': z.string().optional(),
});

export const eiaStocksSchema = z.object({
  response: z.object({
    /** Llega como string en la API v2. */
    total: z.union([z.string(), z.number()]).optional(),
    data: z.array(eiaRowSchema),
  }),
});

/** El error de la EIA llega con HTTP 403/400 y este cuerpo. */
export const eiaErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

export type EiaRow = z.infer<typeof eiaRowSchema>;

/**
 * El valor como numero, o `null` si no lo es. Un string vacio o con texto no es un 0: es un dato
 * que se descarta con motivo, igual que el `null` de la propia EIA.
 */
export function numericValue(value: string | number | null): number | null {
  if (value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Medianoche UTC del dia. Los `period` de la EIA no llevan hora. */
export function toTimestamp(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

/**
 * Cuando se anuncia la publicacion del informe de un `period`: el primer miercoles posterior al
 * cierre de la semana, a las 10:30 de Nueva York.
 */
export function releaseInstant(periodMs: number): number {
  const wednesday = nextWeekday(periodMs, EIA_RELEASE_WEEKDAY);
  return atEasternTime(wednesday, EIA_RELEASE_HOUR_ET, EIA_RELEASE_MINUTE_ET);
}
