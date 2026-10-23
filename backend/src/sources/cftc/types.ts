import { z } from 'zod';
import { atEasternTime, nextWeekday } from '../eastern-time.js';

export const CFTC_SOURCE_ID = 'cftc';

/** Informe semanal legacy, solo futuros. Publico y sin clave. */
export const CFTC_LEGACY_FUTURES_URL = 'https://www.cftc.gov/dea/newcot/deafut.txt';

/** Tipo de evento con el que entra el informe en `market_events`. */
export const CFTC_REPORT_EVENT_TYPE = 'cftc-cot';

/**
 * El COT refleja las posiciones del **martes** y se publica el **viernes a las 15:30 de Nueva
 * York**. Tratar la fecha del informe como si se conociera el martes es look-ahead bias de tres
 * dias, el error clasico con esta serie.
 */
export const CFTC_PUBLICATION_WEEKDAY = 5;
export const CFTC_PUBLICATION_HOUR_ET = 15;
export const CFTC_PUBLICATION_MINUTE_ET = 30;

export interface CftcMarket {
  readonly seriesId: string;
  readonly assetTag: string;
  readonly label: string;
}

/**
 * Los tres mercados del ticket, elegidos por **codigo de contrato** y no por nombre: el nombre
 * cambia (el 067651 se llamaba "CRUDE OIL, LIGHT SWEET" y hoy es "WTI-PHYSICAL"), el codigo no.
 */
export const CFTC_MARKETS: Readonly<Record<string, CftcMarket>> = {
  '088691': { seriesId: 'gold-net-noncommercial', assetTag: 'gold', label: 'oro (COMEX)' },
  '084691': { seriesId: 'silver-net-noncommercial', assetTag: 'silver', label: 'plata (COMEX)' },
  '067651': { seriesId: 'wti-net-noncommercial', assetTag: 'oil', label: 'WTI (NYMEX)' },
};

export const CFTC_EVENT_TAGS = ['gold', 'silver', 'oil'] as const;

const integerField = z
  .string()
  .transform((value) => value.trim())
  .pipe(z.string().regex(/^-?\d+$/, 'entero'))
  .transform(Number);

/**
 * Solo los campos que se usan, por posicion dentro de la fila (el fichero no trae cabecera). El
 * orden es el del formato legacy, verificado contra el fichero real: las posiciones reportables
 * largas (indice 12) son la suma de no comerciales largas, spread y comerciales largas.
 */
export const cftcRowSchema = z.object({
  marketName: z.string().min(1),
  reportDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'fecha YYYY-MM-DD'),
  contractCode: z.string().min(1),
  openInterest: integerField,
  noncommercialLong: integerField,
  noncommercialShort: integerField,
});

export type CftcRow = z.infer<typeof cftcRowSchema>;

export const CFTC_FIELD = {
  reportDate: 1,
  contractCode: 2,
  openInterest: 6,
  noncommercialLong: 7,
  noncommercialShort: 8,
} as const;

/**
 * El nombre del mercado va entre comillas y **lleva comas dentro** ("CRUDE OIL, LIGHT SWEET-WTI -
 * ICE FUTURES EUROPE"), asi que se separa antes de partir el resto por comas.
 */
export function splitRow(line: string): { marketName: string; fields: string[] } | null {
  const match = /^"([^"]*)",(.*)$/.exec(line.trim());
  const marketName = match?.[1];
  const rest = match?.[2];
  if (marketName === undefined || rest === undefined) return null;
  return { marketName, fields: rest.split(',') };
}

/** El codigo de contrato de una fila, sin validar nada mas: es el filtro del `fetch`. */
export function contractCodeOf(line: string): string | null {
  const row = splitRow(line);
  return row?.fields[CFTC_FIELD.contractCode]?.trim() ?? null;
}

/** Medianoche UTC del dia. Las fechas del informe no llevan hora. */
export function toTimestamp(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

/**
 * Cuando se publica el informe de un martes: el viernes siguiente a las 15:30 de Nueva York. Es el
 * `published_at`, tres dias despues del `scheduled_at`.
 */
export function publicationInstant(reportMs: number): number {
  const friday = nextWeekday(reportMs, CFTC_PUBLICATION_WEEKDAY);
  return atEasternTime(friday, CFTC_PUBLICATION_HOUR_ET, CFTC_PUBLICATION_MINUTE_ET);
}
