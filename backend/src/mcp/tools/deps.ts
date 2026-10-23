import type { Timeframe } from '@tt/shared';
import type { ExportReport } from '../../brain/export/obsidian.js';
import type { CandlesRepository } from '../../db/repositories/candles.repo.js';
import type { DerivativesRepository } from '../../db/repositories/derivatives.repo.js';
import type { DocumentsRepository } from '../../db/repositories/documents.repo.js';
import type { EmbeddingsRepository } from '../../db/repositories/embeddings.repo.js';
import type { EventsRepository } from '../../db/repositories/events.repo.js';
import type { MacroRepository } from '../../db/repositories/macro.repo.js';
import type { NotesRepository } from '../../db/repositories/notes.repo.js';
import type { SearchRepository } from '../../db/repositories/search.repo.js';
import type { AppLogger } from '../../observability/logger.js';
import type { SearchServiceDeps } from '../../api/services/search.service.js';

/**
 * Correspondencia activo -> mercado, versionada en el codigo. Solo hay perpetuos de cripto en el
 * proyecto: para `gold`, `silver`, `oil` o `macro` no hay velas ni funding, y el contexto se queda
 * con eventos, macro y documentos, que es informacion real y no un hueco disfrazado.
 */
export const ASSET_MARKETS: Readonly<Record<string, { exchange: string; symbol: string }>> =
  Object.freeze({
    btc: { exchange: 'binance', symbol: 'BTCUSDT' },
    eth: { exchange: 'binance', symbol: 'ETHUSDT' },
  });

export const DEFAULT_CONTEXT_TIMEFRAME: Timeframe = '1h';

export interface McpToolDeps {
  readonly documents: DocumentsRepository;
  readonly embeddings: EmbeddingsRepository;
  readonly search: SearchRepository;
  readonly macro: MacroRepository;
  readonly events: EventsRepository;
  readonly candles: CandlesRepository;
  readonly derivatives: DerivativesRepository;
  readonly notes: NotesRepository;
  readonly logger: AppLogger;
  readonly now: () => number;
  readonly embedder?: SearchServiceDeps['embedder'];
  /** El export del vault tras `write_note`. Sin ruta de vault devuelve un informe vacio. */
  readonly exportVault: () => Promise<ExportReport>;
}
