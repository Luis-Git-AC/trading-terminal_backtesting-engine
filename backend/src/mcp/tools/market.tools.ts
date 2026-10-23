import {
  MCP_MAX_RESULTS,
  MCP_MAX_SERIES_POINTS,
  getMacroSeriesInputSchema,
  getMarketContextInputSchema,
  listEventsInputSchema,
  type EventsResponse,
  type MacroSeriesResponse,
  type Timeframe,
} from '@tt/shared';
import { NO_CACHE } from '../../api/services/cache.js';
import { getMacroSeries, getMarketEvents } from '../../api/services/macro.service.js';
import { ASSET_MARKETS, DEFAULT_CONTEXT_TIMEFRAME, type McpToolDeps } from './deps.js';

/**
 * Las tools llaman a los mismos servicios que la API, no a los repositorios pelados: el tope de
 * filas, la ambiguedad de fuente y el corte point-in-time estan decididos en un solo sitio. Sin
 * cache, porque aqui no hay un navegador repitiendo la misma peticion.
 */
function serviceDeps(deps: McpToolDeps) {
  return {
    macro: deps.macro,
    events: deps.events,
    cache: NO_CACHE,
    logger: deps.logger,
    now: deps.now,
  };
}

const DAY_MS = 86_400_000;

/**
 * Ventana por defecto de `get_macro_series`. El repositorio sirve de mas antiguo a mas reciente, asi
 * que sin `from` la serie entera devolvia sus 500 puntos mas viejos (DFF arranca en 1954): ni cabe
 * en la respuesta de un cliente MCP ni es lo que se pregunta. Para mas historia, `from` explicito.
 */
const DEFAULT_SERIES_WINDOW_MS = 90 * DAY_MS;

export async function getMacroSeriesTool(
  deps: McpToolDeps,
  input: unknown,
): Promise<MacroSeriesResponse> {
  const query = getMacroSeriesInputSchema.parse(input);

  return getMacroSeries(serviceDeps(deps), {
    seriesId: query.seriesId,
    from: query.from ?? deps.now() - DEFAULT_SERIES_WINDOW_MS,
    limit: query.limit ?? MCP_MAX_SERIES_POINTS,
    ...(query.to === undefined ? {} : { to: query.to }),
    ...(query.asOf === undefined ? {} : { asOf: query.asOf }),
    ...(query.source === undefined ? {} : { source: query.source }),
  });
}

export async function listEventsTool(deps: McpToolDeps, input: unknown): Promise<EventsResponse> {
  const query = listEventsInputSchema.parse(input);

  return getMarketEvents(serviceDeps(deps), {
    from: query.from ?? 0,
    // El tope del schema sigue en 100, pero 100 eventos con su payload no caben en la respuesta de
    // un cliente MCP. Se sirven de mas reciente a mas antiguo, asi que 20 es lo que se pregunta y
    // el resto se pagina con `nextTo`.
    limit: query.limit ?? MCP_MAX_RESULTS,
    ...(query.to === undefined ? {} : { to: query.to }),
    ...(query.asOf === undefined ? {} : { asOf: query.asOf }),
    ...(query.asset === undefined ? {} : { asset: query.asset }),
  });
}

export interface MarketContextResult {
  readonly asset: string;
  readonly date: string;
  /** Corte point-in-time: nada de lo devuelto se conocia despues de este instante. */
  readonly asOf: string;
  readonly market: { exchange: string; symbol: string; timeframe: Timeframe } | null;
  readonly candles: readonly {
    t: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }[];
  readonly funding: readonly { t: string; rate: number; intervalHours: number }[];
  readonly openInterest: readonly { t: string; base: number; quote: number | null }[];
  readonly events: EventsResponse['events'];
  readonly documents: readonly { id: string; source: string; title: string; publishedAt: string }[];
  /** Lo que no se ha podido componer, dicho en vez de devuelto como hueco vacio. */
  readonly notes: readonly string[];
}

/**
 * Compone lo que ya existe para una fecha: velas, funding, OI, eventos cercanos y documentos del
 * dia. **Siempre point-in-time**: el corte es el final del dia pedido, asi que nada publicado o
 * descargado despues entra. Es la garantia anti-look-ahead que hace util analizar una fecha pasada.
 */
export async function getMarketContextTool(
  deps: McpToolDeps,
  input: unknown,
): Promise<MarketContextResult> {
  const query = getMarketContextInputSchema.parse(input);

  const dayStart = Date.parse(`${query.date}T00:00:00Z`);
  const dayEnd = dayStart + DAY_MS - 1;
  // El corte nunca es futuro: pedir el contexto de hoy no puede traer lo de manana.
  const asOf = Math.min(dayEnd, deps.now());

  const configured = ASSET_MARKETS[query.asset];
  const exchange = query.exchange ?? configured?.exchange;
  const symbol = query.symbol ?? configured?.symbol;
  const timeframe = query.timeframe ?? DEFAULT_CONTEXT_TIMEFRAME;
  const notes: string[] = [];

  let candles: MarketContextResult['candles'] = [];
  let funding: MarketContextResult['funding'] = [];
  let openInterest: MarketContextResult['openInterest'] = [];
  let market: MarketContextResult['market'] = null;

  if (exchange === undefined || symbol === undefined) {
    notes.push(
      `El activo ${query.asset} no tiene mercado de perpetuos en este proyecto: no hay velas, funding ni open interest. Pasa \`symbol\` para forzar uno.`,
    );
  } else {
    market = { exchange, symbol, timeframe };
    const range = { exchange, symbol, from: dayStart, to: asOf };

    candles = (await deps.candles.getCandles({ ...range, timeframe })).map((candle) => ({
      t: new Date(candle.t).toISOString(),
      open: candle.o,
      high: candle.h,
      low: candle.l,
      close: candle.c,
      volume: candle.v,
    }));
    funding = (await deps.derivatives.getFundingRates(range)).map((rate) => ({
      t: new Date(rate.t).toISOString(),
      rate: rate.rate,
      intervalHours: rate.intervalHours,
    }));
    openInterest = (await deps.derivatives.getOpenInterest(range)).map((point) => ({
      t: new Date(point.t).toISOString(),
      base: point.base,
      quote: point.quote,
    }));

    if (candles.length === 0) notes.push(`Sin velas de ${symbol} ${timeframe} ese dia.`);
  }

  // Ventana de eventos de +-3 dias: un FOMC de la vispera explica el dia siguiente, y lo que se
  // conoce con antelacion (un evento programado) no es look-ahead mientras `fetched_at` lo respete.
  const events = await getMarketEvents(serviceDeps(deps), {
    from: dayStart - 3 * DAY_MS,
    to: dayEnd + 3 * DAY_MS,
    limit: MCP_MAX_RESULTS,
    asOf,
    asset: query.asset === 'macro' ? ['macro'] : [query.asset, 'macro'],
  });

  const documents = await deps.documents.getDocuments({
    from: dayStart,
    to: dayEnd,
    asOf,
    limit: MCP_MAX_RESULTS,
  });
  const tags = await deps.documents.getTagsForDocuments(documents.map((document) => document.id));

  const relevantes = documents.filter((document) =>
    (tags.get(document.id) ?? []).some((tag) => tag.asset === query.asset || tag.asset === 'macro'),
  );

  return {
    asset: query.asset,
    date: query.date,
    asOf: new Date(asOf).toISOString(),
    market,
    candles,
    funding,
    openInterest,
    events: events.events,
    documents: relevantes.map((document) => ({
      id: document.id,
      source: document.source,
      title: document.title,
      publishedAt: new Date(document.publishedAt).toISOString(),
    })),
    notes,
  };
}
