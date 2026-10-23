import { z } from 'zod';
import { exchangeSchema } from './exchange.js';
import { sourcesHealthSchema } from './sources.js';
import { timeframeSchema } from './timeframe.js';

export const CANDLES_MAX_LIMIT = 5000;

/**
 * Lista blanca estricta: el simbolo acaba en SQL parametrizado y en claves de cache.
 * El segmento opcional tras ':' es el prefijo de dex de los mercados HIP-3 (xyz:GOLD).
 */
export const SYMBOL_PATTERN = /^[A-Z0-9]{2,20}(:[A-Z0-9]{2,20})?$/;

export const SYMBOL_ERROR =
  'El simbolo debe ser alfanumerico en mayusculas, de 2 a 20 caracteres, con un prefijo de dex opcional separado por ":"';

export const symbolSchema = z
  .string()
  .transform((value) => value.toUpperCase())
  .refine((value) => SYMBOL_PATTERN.test(value), { error: SYMBOL_ERROR });

export const timestampParamSchema = z.union([
  z
    .string()
    .regex(/^\d+$/, { error: 'Se espera un epoch en milisegundos o una fecha ISO 8601' })
    .transform((value) => Number(value))
    .refine((value) => Number.isSafeInteger(value) && value >= 0, {
      error: 'Epoch fuera de rango',
    }),
  z
    .string()
    .datetime({ offset: true })
    .transform((value) => Date.parse(value)),
  z
    .string()
    .datetime()
    .transform((value) => Date.parse(value)),
]);

export const CHECK_STATES = ['ok', 'error'] as const;

export const checkStateSchema = z.enum(CHECK_STATES);

export const ingestHealthSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  lastCandleAgeSec: z.number().nullable(),
});

export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  uptimeSec: z.number().int().nonnegative(),
  version: z.string(),
  checks: z.object({
    db: checkStateSchema,
    redis: checkStateSchema,
    ingest: z.union([ingestHealthSchema, checkStateSchema]).optional(),
    sources: z.union([sourcesHealthSchema, checkStateSchema]).optional(),
  }),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const marketSymbolSchema = z.object({
  symbol: z.string(),
  timeframes: z.array(timeframeSchema),
  pricePrecision: z.number().int().nonnegative(),
  qtyPrecision: z.number().int().nonnegative(),
});

export type MarketSymbol = z.infer<typeof marketSymbolSchema>;

export const marketExchangeSchema = z.object({
  exchange: exchangeSchema,
  symbols: z.array(marketSymbolSchema),
});

export type MarketExchange = z.infer<typeof marketExchangeSchema>;

export const marketsResponseSchema = z.object({
  exchanges: z.array(marketExchangeSchema),
});

export type MarketsResponse = z.infer<typeof marketsResponseSchema>;

export const coverageParamsSchema = z.object({
  exchange: exchangeSchema,
  symbol: symbolSchema,
});

export const coverageQuerySchema = z.object({ timeframe: timeframeSchema });

export const coverageGapSchema = z.object({
  from: z.string(),
  to: z.string(),
  filled: z.boolean(),
});

export const coverageResponseSchema = z.object({
  exchange: exchangeSchema,
  symbol: z.string(),
  timeframe: timeframeSchema,
  from: z.string().nullable(),
  to: z.string().nullable(),
  candles: z.number().int().nonnegative(),
  expected: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
  gaps: z.array(coverageGapSchema),
  backfill: z.object({
    done: z.boolean(),
    cursor: z.string().nullable(),
  }),
});

export type CoverageResponse = z.infer<typeof coverageResponseSchema>;

export const candlesQuerySchema = z.object({
  exchange: exchangeSchema,
  symbol: symbolSchema,
  timeframe: timeframeSchema,
  from: timestampParamSchema,
  to: timestampParamSchema.optional(),
  limit: z
    .string()
    .regex(/^\d+$/, { error: 'limit debe ser un entero' })
    .transform((value) => Number(value))
    .refine((value) => value >= 1, { error: 'limit debe ser al menos 1' })
    .optional(),
});

export type CandlesQuery = z.infer<typeof candlesQuerySchema>;

export const compactCandleSchema = z.object({
  t: z.number().int().nonnegative(),
  o: z.number(),
  h: z.number(),
  l: z.number(),
  c: z.number(),
  v: z.number(),
});

export const candlesResponseSchema = z.object({
  exchange: exchangeSchema,
  symbol: z.string(),
  timeframe: timeframeSchema,
  count: z.number().int().nonnegative(),
  candles: z.array(compactCandleSchema),
  nextFrom: z.number().int().nonnegative().nullable(),
});

export type CandlesResponse = z.infer<typeof candlesResponseSchema>;

export const derivativesParamsSchema = z.object({
  exchange: exchangeSchema,
  symbol: symbolSchema,
});

export const derivativesQuerySchema = z.object({
  from: timestampParamSchema,
  to: timestampParamSchema.optional(),
  limit: z
    .string()
    .regex(/^\d+$/, { error: 'limit debe ser un entero' })
    .transform((value) => Number(value))
    .refine((value) => value >= 1, { error: 'limit debe ser al menos 1' })
    .optional(),
});

export type DerivativesQuery = z.infer<typeof derivativesQuerySchema>;

export const fundingRateSchema = z.object({
  t: z.number().int().nonnegative(),
  rate: z.number(),
  intervalHours: z.number().int().positive(),
});

export const fundingResponseSchema = z.object({
  exchange: exchangeSchema,
  symbol: z.string(),
  count: z.number().int().nonnegative(),
  funding: z.array(fundingRateSchema),
  nextFrom: z.number().int().nonnegative().nullable(),
});

export type FundingResponse = z.infer<typeof fundingResponseSchema>;

export const openInterestPointSchema = z.object({
  t: z.number().int().nonnegative(),
  base: z.number(),
  quote: z.number().nullable(),
});

export const openInterestResponseSchema = z.object({
  exchange: exchangeSchema,
  symbol: z.string(),
  count: z.number().int().nonnegative(),
  openInterest: z.array(openInterestPointSchema),
  nextFrom: z.number().int().nonnegative().nullable(),
});

export type OpenInterestResponse = z.infer<typeof openInterestResponseSchema>;

export const MACRO_MAX_LIMIT = 5000;
export const EVENTS_MAX_LIMIT = 1000;

/** Ids de serie y de fuente: lista blanca estricta, acaban en SQL parametrizado y en claves de cache. */
export const SERIES_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const seriesIdSchema = z.string().refine((value) => SERIES_ID_PATTERN.test(value), {
  error: 'El id de serie debe ser alfanumerico, con guiones o guiones bajos, de 1 a 64 caracteres',
});

const limitParamSchema = z
  .string()
  .regex(/^\d+$/, { error: 'limit debe ser un entero' })
  .transform((value) => Number(value))
  .refine((value) => value >= 1, { error: 'limit debe ser al menos 1' })
  .optional();

export const macroParamsSchema = z.object({
  seriesId: seriesIdSchema,
});

export const macroQuerySchema = z.object({
  from: timestampParamSchema,
  to: timestampParamSchema.optional(),
  /**
   * Corte point-in-time (ADR-006): devuelve lo que ya estaba descargado en ese instante, que es lo
   * que se sabia entonces. Sin el, lo ultimo conocido.
   */
  asOf: timestampParamSchema.optional(),
  /** Solo hace falta cuando dos fuentes publican una serie con el mismo id. */
  source: seriesIdSchema.optional(),
  limit: limitParamSchema,
});

export type MacroQuery = z.infer<typeof macroQuerySchema>;

export const macroPointSchema = z.object({
  t: z.number().int().nonnegative(),
  value: z.number(),
  publishedAt: z.number().int().nonnegative(),
  fetchedAt: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
});

export const macroSeriesResponseSchema = z.object({
  source: z.string(),
  seriesId: z.string(),
  count: z.number().int().nonnegative(),
  points: z.array(macroPointSchema),
  asOf: z.number().int().nonnegative().nullable(),
  nextFrom: z.number().int().nonnegative().nullable(),
});

export type MacroSeriesResponse = z.infer<typeof macroSeriesResponseSchema>;

export const eventsQuerySchema = z.object({
  from: timestampParamSchema,
  to: timestampParamSchema.optional(),
  asOf: timestampParamSchema.optional(),
  /** Etiqueta de activo (`oil`, `gold`, `macro`…); varias separadas por comas. */
  asset: z
    .string()
    .transform((value) =>
      value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0),
    )
    .pipe(z.array(seriesIdSchema).min(1))
    .optional(),
  limit: limitParamSchema,
});

export type EventsQuery = z.infer<typeof eventsQuerySchema>;

export const marketEventSchema = z.object({
  id: z.string(),
  source: z.string(),
  type: z.string(),
  assetTags: z.array(z.string()),
  /** Cuando ocurre o a que se refiere el dato (el martes del COT, el miercoles de la EIA). */
  scheduledAt: z.number().int().nonnegative(),
  publishedAt: z.number().int().nonnegative(),
  fetchedAt: z.number().int().nonnegative(),
  payload: z.record(z.string(), z.unknown()),
});

export const eventsResponseSchema = z.object({
  count: z.number().int().nonnegative(),
  events: z.array(marketEventSchema),
  asOf: z.number().int().nonnegative().nullable(),
  /**
   * Los eventos se sirven del mas reciente al mas antiguo, asi que se pagina hacia atras: el
   * siguiente tramo es `to = nextTo`, no `from`.
   */
  nextTo: z.number().int().nonnegative().nullable(),
});

export type EventsResponse = z.infer<typeof eventsResponseSchema>;

export const DOCUMENTS_MAX_LIMIT = 50;

/** Modo real de la respuesta: `hybrid` fusiona full-text y vectores; `fulltext` es el degradado. */
export const SEARCH_MODES = ['hybrid', 'fulltext'] as const;

export type SearchMode = (typeof SEARCH_MODES)[number];

const csvSchema = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  )
  .pipe(z.array(seriesIdSchema).min(1))
  .optional();

export const documentsSearchQuerySchema = z.object({
  /** Texto libre; se interpreta con `websearch_to_tsquery` (comillas, `or`, `-palabra`). */
  q: z.string().trim().min(2).max(200),
  /** Sin rango se busca en todo el corpus, que es lo normal en una busqueda. */
  from: timestampParamSchema.optional(),
  to: timestampParamSchema.optional(),
  asOf: timestampParamSchema.optional(),
  asset: csvSchema,
  source: csvSchema,
  limit: limitParamSchema,
});

export type DocumentsSearchQuery = z.infer<typeof documentsSearchQuerySchema>;

export const documentParamsSchema = z.object({
  id: z.uuid(),
});

export const documentSchema = z.object({
  id: z.string(),
  source: z.string(),
  url: z.string(),
  title: z.string(),
  publishedAt: z.number().int().nonnegative(),
  /** `true` cuando el feed no traia fecha o venia en el futuro y se uso `fetchedAt`. */
  publishedAtEstimated: z.boolean(),
  fetchedAt: z.number().int().nonnegative(),
  lang: z.string().nullable(),
  assets: z.array(z.string()),
});

export const documentSearchResultSchema = documentSchema.extend({
  /** Principio del cuerpo ya saneado a texto: el documento completo va en `/api/documents/:id`. */
  snippet: z.string(),
  /** Puntuacion de la fusion (Reciprocal Rank Fusion). Mayor es mejor. */
  score: z.number(),
  /** Posicion en cada ranking de origen, `null` si ese ranking no lo devolvio. */
  fullTextRank: z.number().int().positive().nullable(),
  vectorRank: z.number().int().positive().nullable(),
});

export const documentsSearchResponseSchema = z.object({
  query: z.string(),
  mode: z.enum(SEARCH_MODES),
  /** Por que se degrado a full-text, cuando se degrado. */
  degradedReason: z.string().nullable(),
  count: z.number().int().nonnegative(),
  results: z.array(documentSearchResultSchema),
  asOf: z.number().int().nonnegative().nullable(),
});

export type DocumentsSearchResponse = z.infer<typeof documentsSearchResponseSchema>;

export const documentResponseSchema = documentSchema.extend({
  body: z.string(),
  contentHash: z.string(),
  /** Etiquetas con la regla que las puso, para saber por que esta etiquetado asi. */
  tags: z.array(z.object({ asset: z.string(), ruleId: z.string() })),
});

export type DocumentResponse = z.infer<typeof documentResponseSchema>;
