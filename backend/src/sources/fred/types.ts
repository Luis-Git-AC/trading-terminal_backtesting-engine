import { z } from 'zod';

export const FRED_SOURCE_ID = 'fred';
export const FRED_OBSERVATIONS_PATH = '/fred/series/observations';
export const FRED_RELEASE_DATES_PATH = '/fred/releases/dates';

/**
 * Ventana realtime completa. Con `output_type=1` (el de por defecto) y esta ventana, el FRED
 * devuelve **una fila por vintage** de cada fecha de observacion, cada una con su propio
 * `realtime_start`: de ahi sale `published_at` y de ahi sale la revision. Con la ventana por
 * defecto (hoy, hoy) solo llegaria la ultima, y la revision seria invisible.
 */
export const FRED_REALTIME_START = '1776-07-04';
export const FRED_REALTIME_END = '9999-12-31';

/** El maximo que admite `limit` en `releases/dates`. */
export const FRED_RELEASE_DATES_LIMIT = 1000;

/** Tipo de evento con el que entra el calendario de publicaciones en `market_events`. */
export const FRED_RELEASE_EVENT_TYPE = 'fred-release';

export const FRED_EVENT_TAGS = ['macro', 'usd'] as const;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'fecha YYYY-MM-DD');

export const fredObservationSchema = z.object({
  realtime_start: isoDate,
  realtime_end: isoDate,
  date: isoDate,
  /** Siempre string. Un dato ausente llega como `"."`, no como null ni como 0. */
  value: z.string(),
});

export const fredObservationsSchema = z.object({
  observations: z.array(fredObservationSchema),
});

export const fredReleaseDateSchema = z.object({
  release_id: z.number().int(),
  /** Documentado en todos los ejemplos, pero no lo exigimos: sin el se usa el id. */
  release_name: z.string().optional(),
  date: isoDate,
});

export const fredReleaseDatesSchema = z.object({
  release_dates: z.array(fredReleaseDateSchema),
});

/** El error del FRED llega con HTTP 400 y este cuerpo. */
export const fredErrorSchema = z.object({
  error_code: z.number().int(),
  error_message: z.string(),
});

export type FredObservation = z.infer<typeof fredObservationSchema>;
export type FredReleaseDate = z.infer<typeof fredReleaseDateSchema>;

/** Medianoche UTC del dia. Las fechas del FRED no llevan hora. */
export function toTimestamp(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}
