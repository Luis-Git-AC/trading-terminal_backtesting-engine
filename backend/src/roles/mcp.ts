import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Pool } from 'pg';
import { exportVault } from '../brain/export/obsidian-export.js';
import { createCandlesRepository } from '../db/repositories/candles.repo.js';
import { createDerivativesRepository } from '../db/repositories/derivatives.repo.js';
import { createDocumentsRepository } from '../db/repositories/documents.repo.js';
import { createEmbeddingsRepository } from '../db/repositories/embeddings.repo.js';
import { createEventsRepository } from '../db/repositories/events.repo.js';
import { createMacroRepository } from '../db/repositories/macro.repo.js';
import { createNotesRepository } from '../db/repositories/notes.repo.js';
import { createSearchRepository } from '../db/repositories/search.repo.js';
import { buildMcpServer } from '../mcp/server.js';
import type { McpToolDeps } from '../mcp/tools/deps.js';
import type { AppLogger } from '../observability/logger.js';
import { DEFAULT_SIGNALS } from './collector.js';

export interface StartMcpOptions {
  readonly pool: Pool;
  readonly logger: AppLogger;
  readonly embedder?: McpToolDeps['embedder'];
  readonly vaultPath?: string | undefined;
  readonly closePool?: boolean;
  readonly signals?: readonly NodeJS.Signals[];
}

export interface McpHandle {
  readonly deps: McpToolDeps;
  stop(): Promise<void>;
}

/**
 * Construye las dependencias de las tools leyendo **de la base de datos** por los repositorios, no
 * por HTTP contra el rol `api`: un salto menos y el mismo contrato Zod.
 */
export function buildMcpDeps(options: StartMcpOptions): McpToolDeps {
  const { pool, logger } = options;
  const documents = createDocumentsRepository(pool);
  const events = createEventsRepository(pool);
  const notes = createNotesRepository(pool);

  return {
    documents,
    events,
    notes,
    embeddings: createEmbeddingsRepository(pool),
    search: createSearchRepository(pool),
    macro: createMacroRepository(pool),
    candles: createCandlesRepository(pool),
    derivatives: createDerivativesRepository(pool),
    logger,
    now: () => Date.now(),
    ...(options.embedder === undefined ? {} : { embedder: options.embedder }),
    exportVault: () =>
      exportVault({
        documents,
        events,
        notes,
        logger,
        now: () => Date.now(),
        ...(options.vaultPath === undefined ? {} : { vaultPath: options.vaultPath }),
      }),
  };
}

/**
 * Un rol mas del mismo artefacto, por **stdio**, que es como lo arrancan Claude Code y la app de
 * escritorio. El transporte HTTP queda fuera: en local no hace falta y anade superficie.
 *
 * El log tiene que ir a stderr: stdout es el canal JSON-RPC y una linea de log ahi rompe la sesion.
 * Lo garantiza `runMcp` en `main.ts` creando el logger contra `process.stderr`.
 */
export async function startMcp(options: StartMcpOptions): Promise<McpHandle> {
  const deps = buildMcpDeps(options);
  const server = buildMcpServer(deps);
  const transport = new StdioServerTransport();

  await server.connect(transport);
  options.logger.info({ transport: 'stdio' }, 'MCP server conectado');

  const handlers = new Map<NodeJS.Signals, () => void>();
  let stopping: Promise<void> | undefined;

  function stop(): Promise<void> {
    stopping ??= (async () => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
      handlers.clear();

      await server.close();
      if (options.closePool !== false) await options.pool.end();
    })();

    return stopping;
  }

  for (const signal of options.signals ?? DEFAULT_SIGNALS) {
    const handler = (): void => {
      void stop();
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }

  return { deps, stop };
}
