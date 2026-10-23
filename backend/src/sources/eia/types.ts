import { z } from 'zod';

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
export const EIA_RELEASE_TIMEZONE = 'America/New_York';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'fecha YYYY-MM-DD');

export const eiaRowSchema = z.object({
  period: isoDate,
  series: z.string(),
  /** Numero, no string (al contrario que el FRED). Un dato ausente llega como `null`. */
  value: z.number().nullable(),
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

/** Medianoche UTC del dia. Los `period` de la EIA no llevan hora. */
export function toTimestamp(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const zonedFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: EIA_RELEASE_TIMEZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

function zonedParts(utcMs: number): ZonedParts {
  const parts = new Map(
    zonedFormat.formatToParts(utcMs).map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: parts.get('year') ?? 0,
    month: parts.get('month') ?? 1,
    day: parts.get('day') ?? 1,
    hour: parts.get('hour') ?? 0,
    minute: parts.get('minute') ?? 0,
  };
}

/** Lo que Nueva York adelanta o atrasa respecto a UTC en ese instante: EST o EDT segun la fecha. */
function offsetMs(utcMs: number): number {
  const local = zonedParts(utcMs);
  return Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute) - utcMs;
}

/**
 * Instante UTC de las `hour:minute` de Nueva York del dia `utcDayMs`. Dos pasadas: la primera
 * corrige con el desplazamiento del dia y la segunda con el del instante ya corregido, que es lo
 * que resuelve los domingos de cambio de hora.
 */
function atEasternTime(utcDayMs: number, hour: number, minute: number): number {
  const day = new Date(utcDayMs);
  const wall = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, minute);
  const first = wall - offsetMs(wall);
  return wall - offsetMs(first);
}

/**
 * Cuando se anuncia la publicacion del informe de un `period`: el primer miercoles posterior al
 * cierre de la semana, a las 10:30 de Nueva York.
 */
export function releaseInstant(periodMs: number): number {
  const DAY = 24 * 60 * 60 * 1000;
  let dayMs = periodMs + DAY;
  while (new Date(dayMs).getUTCDay() !== EIA_RELEASE_WEEKDAY) dayMs += DAY;
  return atEasternTime(dayMs, EIA_RELEASE_HOUR_ET, EIA_RELEASE_MINUTE_ET);
}
