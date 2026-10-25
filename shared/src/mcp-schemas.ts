import { z } from 'zod';
import { createBacktestBodySchema } from './backtest-schemas.js';

/**
 * Esquemas de las tools del MCP server. Separados de `api-schemas.ts` a proposito: por HTTP todo
 * llega como texto en el query string, pero una tool recibe JSON, asi que aqui un numero es un
 * numero y una lista es una lista. Validar en el borde sigue siendo obligatorio (CLAUDE.md §6).
 */

/** Tope de resultados por pagina: 200 documentos enteros se comen la ventana de contexto. */
export const MCP_MAX_RESULTS = 20;

/** Lo que se devuelve del cuerpo en un resultado de busqueda. El completo, con `get_document`. */
export const MCP_SNIPPET_CHARS = 400;

/** Tope del cuerpo en `get_document`: un articulo largo cabe, un volcado de 10 MB no. */
export const MCP_BODY_CHARS = 20_000;

export const MCP_MAX_SERIES_POINTS = 500;

const assetSchema = z
  .string()
  .regex(/^[a-z0-9_-]{1,32}$/u, { error: 'El activo es alfanumerico en minusculas' });

const epochMsSchema = z
  .number()
  .int()
  .nonnegative()
  .max(4_102_444_800_000, { error: 'Fecha fuera de rango (posterior a 2100)' });

/** Fecha en `YYYY-MM-DD`: una tool la recibe de Claude escrita a mano, no como epoch. */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, { error: 'La fecha va en formato YYYY-MM-DD' })
  .refine((value) => Number.isFinite(Date.parse(`${value}T00:00:00Z`)), {
    error: 'La fecha no existe',
  });

const limitSchema = (max: number) => z.number().int().min(1).max(max).optional();

/**
 * `asOf` es el corte point-in-time de ADR-006: lo que ya estaba descargado en ese instante. Es lo
 * que permite analizar una fecha pasada sin contaminarla con lo publicado despues.
 */
const asOfSchema = epochMsSchema.optional();

export const searchDocumentsShape = {
  q: z.string().trim().min(2).max(200),
  asset: z.array(assetSchema).min(1).max(16).optional(),
  source: z.array(assetSchema).min(1).max(16).optional(),
  from: epochMsSchema.optional(),
  to: epochMsSchema.optional(),
  asOf: asOfSchema,
  limit: limitSchema(MCP_MAX_RESULTS),
  /** Paginacion: cuantos resultados saltarse. El orden del ranking es determinista. */
  offset: z.number().int().min(0).max(1000).optional(),
};

export const searchDocumentsInputSchema = z.object(searchDocumentsShape);

export const getDocumentShape = {
  id: z.uuid(),
};

export const getDocumentInputSchema = z.object(getDocumentShape);

export const getMacroSeriesShape = {
  seriesId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u, { error: 'El id de serie es alfanumerico' }),
  from: epochMsSchema.optional(),
  to: epochMsSchema.optional(),
  asOf: asOfSchema,
  source: assetSchema.optional(),
  limit: limitSchema(MCP_MAX_SERIES_POINTS),
};

export const getMacroSeriesInputSchema = z.object(getMacroSeriesShape);

export const listEventsShape = {
  from: epochMsSchema.optional(),
  to: epochMsSchema.optional(),
  asset: z.array(assetSchema).min(1).max(16).optional(),
  asOf: asOfSchema,
  limit: limitSchema(MCP_MAX_RESULTS * 5),
};

export const listEventsInputSchema = z.object(listEventsShape);

export const getMarketContextShape = {
  asset: assetSchema,
  /** El dia que se analiza. El corte point-in-time es su final, nunca despues. */
  date: isoDateSchema,
  /** Para un activo sin perpetuo en el proyecto no hay velas; se puede forzar el simbolo. */
  symbol: z
    .string()
    .regex(/^[A-Z0-9]{3,20}$/u, { error: 'El simbolo va en mayusculas' })
    .optional(),
  exchange: z.enum(['binance', 'hyperliquid']).optional(),
  timeframe: z.enum(['1m', '15m', '1h']).optional(),
};

export const getMarketContextInputSchema = z.object(getMarketContextShape);

export const writeNoteShape = {
  bodyMd: z.string().trim().min(1).max(100_000),
  assets: z.array(assetSchema).max(16).optional(),
  sourceDocumentIds: z.array(z.uuid()).max(50).optional(),
};

export const writeNoteInputSchema = z.object(writeNoteShape);

export const listStrategiesShape = {};

export const runBacktestShape = createBacktestBodySchema.shape;

export const MCP_TOOL_NAMES = [
  'search_documents',
  'get_document',
  'get_macro_series',
  'list_events',
  'get_market_context',
  'write_note',
  'list_strategies',
  'run_backtest',
] as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];
