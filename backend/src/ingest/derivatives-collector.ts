import type { Pool } from 'pg';
import { createDerivativesRepository } from '../db/repositories/derivatives.repo.js';
import type { ExchangeDerivativesClient } from './exchange/adapter.js';

/** shortcut: funding/OI en el ingestor, mover al collector en F9-T1 */

/** Cuanto se pide hacia atras la primera vez que se recoge un mercado. */
export const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

export interface CollectDerivativesOptions {
  pool: Pool;
  client: ExchangeDerivativesClient;
  exchange: string;
  symbols: readonly string[];
  lookbackMs?: number;
  now?: () => number;
  log?: (event: CollectDerivativesEvent) => void;
}

export interface SymbolResult {
  symbol: string;
  funding: number;
  openInterest: number;
  error: string | null;
}

export interface CollectDerivativesReport {
  exchange: string;
  results: SymbolResult[];
  funding: number;
  openInterest: number;
  failed: number;
}

export type CollectDerivativesEvent =
  | { kind: 'symbol'; exchange: string; result: SymbolResult }
  | { kind: 'finish'; report: CollectDerivativesReport };

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Recoge funding y open interest de un exchange y los persiste. Reanuda desde el ultimo `ts`
 * guardado de cada mercado, asi que repetirla no vuelve a pedir lo que ya esta.
 */
export async function collectDerivatives(
  options: CollectDerivativesOptions,
): Promise<CollectDerivativesReport> {
  const {
    pool,
    client,
    exchange,
    symbols,
    lookbackMs = DEFAULT_LOOKBACK_MS,
    now = Date.now,
    log = (): void => undefined,
  } = options;

  const repo = createDerivativesRepository(pool);
  const report: CollectDerivativesReport = {
    exchange,
    results: [],
    funding: 0,
    openInterest: 0,
    failed: 0,
  };

  for (const symbol of symbols) {
    const result: SymbolResult = { symbol, funding: 0, openInterest: 0, error: null };

    try {
      const market = { exchange, symbol };
      const floor = now() - lookbackMs;

      const lastFunding = await repo.getLastFundingTs(market);
      const rates = await client.getFundingHistory({
        symbol,
        startTime: lastFunding === null ? floor : lastFunding + 1,
      });
      result.funding = await repo.upsertFundingRates({ ...market, source: 'rest', rates });

      const lastOi = await repo.getLastOpenInterestTs(market);
      const history = await client.getOpenInterestHistory({
        symbol,
        startTime: lastOi === null ? floor : lastOi + 1,
      });
      const current = await client.getOpenInterest(symbol);
      result.openInterest = await repo.upsertOpenInterest({
        ...market,
        source: 'rest',
        points: [...history, current],
      });
    } catch (error) {
      result.error = describe(error);
      report.failed += 1;
    }

    report.results.push(result);
    report.funding += result.funding;
    report.openInterest += result.openInterest;
    log({ kind: 'symbol', exchange, result });
  }

  log({ kind: 'finish', report });
  return report;
}
