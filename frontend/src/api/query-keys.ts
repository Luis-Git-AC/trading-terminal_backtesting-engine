import type { Exchange, Timeframe } from '@tt/shared';
import type { CandlesRequest, RunsRequest, TradesRequest } from '@/api/resources';

export const queryKeys = {
  health: () => ['health'] as const,

  markets: () => ['markets'] as const,

  coverage: (
    exchange: Exchange | undefined,
    symbol: string | undefined,
    timeframe: Timeframe | undefined,
  ) => ['coverage', exchange ?? null, symbol ?? null, timeframe ?? null] as const,

  candles: (request: CandlesRequest | undefined) =>
    [
      'candles',
      request?.exchange ?? null,
      request?.symbol ?? null,
      request?.timeframe ?? null,
      request?.from ?? null,
      request?.to ?? null,
      request?.limit ?? null,
    ] as const,

  strategies: () => ['strategies'] as const,

  runs: () => ['runs'] as const,

  runList: (request: RunsRequest) =>
    [
      'runs',
      'list',
      request.status ?? null,
      request.limit ?? null,
      request.offset ?? null,
    ] as const,

  run: (runId: string | undefined) => ['runs', 'detail', runId ?? null] as const,

  runTrades: (request: TradesRequest | undefined) =>
    [
      'runs',
      'detail',
      request?.runId ?? null,
      'trades',
      request?.limit ?? null,
      request?.cursor ?? null,
    ] as const,

  runEquity: (runId: string | undefined) => ['runs', 'detail', runId ?? null, 'equity'] as const,

  runCompare: (ids: readonly string[]) => ['runs', 'compare', [...ids].sort()] as const,
} as const;
