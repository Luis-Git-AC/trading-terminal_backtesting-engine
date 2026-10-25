import {
  getDocumentShape,
  getMacroSeriesShape,
  getMarketContextShape,
  listEventsShape,
  compareRunsShape,
  getRunMetricsShape,
  listStrategiesShape,
  runBacktestShape,
  searchDocumentsShape,
  writeNoteShape,
  MCP_BODY_CHARS,
  MCP_MAX_RESULTS,
  MCP_SAMPLE_POINTS,
  MCP_SAMPLE_TRADES,
} from '@tt/shared';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ZodError } from 'zod';
import { AppError } from '../api/errors.js';
import { getDocumentTool, searchDocumentsTool, writeNoteTool } from './tools/documents.tools.js';
import { getMacroSeriesTool, getMarketContextTool, listEventsTool } from './tools/market.tools.js';
import { listStrategiesTool } from './tools/list-strategies.js';
import { runBacktestTool } from './tools/run-backtest.js';
import { compareRunsTool, getRunMetricsTool } from './tools/run-results.js';
import type { McpToolDeps } from './tools/deps.js';

export const MCP_SERVER_NAME = 'trading-terminal';

export const MCP_SERVER_VERSION = '0.1.0';

/** Lo que devuelve una tool: JSON en un bloque de texto, que es lo que todo cliente sabe leer. */
function ok(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

/**
 * Un input invalido es un error de la tool, no una excepcion cruda: el cliente tiene que poder
 * leer que le ha faltado y volver a llamar. Zod da la ruta exacta del campo.
 */
function fail(error: unknown): CallToolResult {
  const message =
    error instanceof AppError
      ? JSON.stringify(error.toEnvelope())
      : error instanceof ZodError
        ? `Input invalido: ${error.issues
            .map((issue) => `${issue.path.join('.') || '(raiz)'}: ${issue.message}`)
            .join('; ')}`
        : error instanceof Error
          ? error.message
          : String(error);

  return { isError: true, content: [{ type: 'text', text: message }] };
}

async function run(
  deps: McpToolDeps,
  name: string,
  handler: () => Promise<unknown>,
): Promise<CallToolResult> {
  try {
    return ok(await handler());
  } catch (error) {
    deps.logger.warn({ tool: name, err: error }, 'la tool devolvio un error');
    return fail(error);
  }
}

/**
 * Ninguna tool manda ordenes. `write_note` escribe solo en `notes` y `run_backtest` solo crea un run
 * en `backtest_runs` por el mismo servicio que `POST /api/backtests`.
 */
export function buildMcpServer(deps: McpToolDeps): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    'search_documents',
    {
      title: 'Buscar noticias y documentos',
      description: [
        'Busqueda hibrida (full-text + vectorial con fusion RRF) sobre las noticias ingeridas.',
        `Devuelve hasta ${String(MCP_MAX_RESULTS)} resultados por pagina con el cuerpo recortado;`,
        'usa `offset` para la siguiente pagina y `get_document` para el texto completo.',
        '`asOf` es el corte point-in-time: solo lo que ya estaba descargado en ese instante.',
      ].join(' '),
      inputSchema: searchDocumentsShape,
      annotations: { readOnlyHint: true },
    },
    (input) => run(deps, 'search_documents', () => searchDocumentsTool(deps, input)),
  );

  server.registerTool(
    'get_document',
    {
      title: 'Leer un documento completo',
      description: `Documento con su cuerpo (hasta ${String(MCP_BODY_CHARS)} caracteres) y sus etiquetas, con la regla que puso cada una.`,
      inputSchema: getDocumentShape,
      annotations: { readOnlyHint: true },
    },
    (input) => run(deps, 'get_document', () => getDocumentTool(deps, input)),
  );

  server.registerTool(
    'get_macro_series',
    {
      title: 'Serie macro',
      description:
        'Puntos de una serie macro (FRED, EIA, CFTC, DefiLlama, CoinGecko) con sus revisiones. Sin `from` devuelve los ultimos 90 dias; pasa `from` en epoch ms para mas historia. `asOf` devuelve el valor que se conocia en ese instante, no el corregido despues.',
      inputSchema: getMacroSeriesShape,
      annotations: { readOnlyHint: true },
    },
    (input) => run(deps, 'get_macro_series', () => getMacroSeriesTool(deps, input)),
  );

  server.registerTool(
    'list_events',
    {
      title: 'Eventos de mercado',
      description:
        'Eventos programados y publicaciones (FOMC, informes de la EIA, COT) filtrables por activo y rango, con corte point-in-time. Del mas reciente al mas antiguo, 20 por defecto; sigue con `nextTo` en `to`.',
      inputSchema: listEventsShape,
      annotations: { readOnlyHint: true },
    },
    (input) => run(deps, 'list_events', () => listEventsTool(deps, input)),
  );

  server.registerTool(
    'get_market_context',
    {
      title: 'Contexto de mercado de una fecha',
      description:
        'Compone velas, funding, open interest, eventos cercanos y documentos del dia para un activo. Siempre point-in-time al final del dia pedido: nada publicado despues entra, asi que una fecha pasada se puede analizar sin contaminarla.',
      inputSchema: getMarketContextShape,
      annotations: { readOnlyHint: true },
    },
    (input) => run(deps, 'get_market_context', () => getMarketContextTool(deps, input)),
  );

  server.registerTool(
    'write_note',
    {
      title: 'Escribir una nota',
      description:
        'Guarda una nota con `author = claude` y la exporta al vault de Obsidian en la misma operacion. Es la unica tool que escribe, y solo en la tabla de notas: las notas de Claude nunca son input de un backtest.',
      inputSchema: writeNoteShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    (input) => run(deps, 'write_note', () => writeNoteTool(deps, input)),
  );

  server.registerTool(
    'list_strategies',
    {
      title: 'Catalogo de estrategias',
      description:
        'Estrategias disponibles con sus parametros: tipo, rango (min/max), opciones y valor por defecto. Usalo antes de `run_backtest` para construir `params` validos.',
      inputSchema: listStrategiesShape,
      annotations: { readOnlyHint: true },
    },
    () => run(deps, 'list_strategies', () => Promise.resolve(listStrategiesTool())),
  );

  server.registerTool(
    'run_backtest',
    {
      title: 'Lanzar un backtest',
      description:
        'Encola un backtest con la misma validacion y los mismos limites que `POST /api/backtests` y devuelve `runId`, `seed` y `paramsHash` sin esperar a que termine. Sin `seed` se genera uno y se devuelve: guardalo para reproducir el run. `from`/`to` en epoch ms o ISO 8601. Solo paper trading: nunca envia ordenes.',
      inputSchema: runBacktestShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    (input) => run(deps, 'run_backtest', () => runBacktestTool(deps, input)),
  );

  server.registerTool(
    'get_run_metrics',
    {
      title: 'Estado y metricas de un backtest',
      description: `Estado del run (queued, running con su progreso, completed, failed con su error, cancelled) y, si termino, sus metricas, una muestra de ${String(MCP_SAMPLE_TRADES)} trades y la curva de equity reducida a ${String(MCP_SAMPLE_POINTS)} puntos, con el total real de cada una. Todo lo calculo el worker; aqui no se recalcula nada.`,
      inputSchema: getRunMetricsShape,
      annotations: { readOnlyHint: true },
    },
    (input) => run(deps, 'get_run_metrics', () => getRunMetricsTool(deps, input)),
  );

  server.registerTool(
    'compare_runs',
    {
      title: 'Comparar backtests',
      description: `Compara de 2 a 4 runs con el mismo servicio que la vista de comparacion: resumen y metricas de cada uno, curvas normalizadas a base 100 (muestra de ${String(MCP_SAMPLE_POINTS)} puntos con el total) y avisos: engine-version-mismatch si el motor no es el mismo y exchange-mismatch si cada run vio la serie de un exchange distinto.`,
      inputSchema: compareRunsShape,
      annotations: { readOnlyHint: true },
    },
    (input) => run(deps, 'compare_runs', () => compareRunsTool(deps, input)),
  );

  return server;
}
