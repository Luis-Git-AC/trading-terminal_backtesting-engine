import type { Pool } from 'pg';
import { timeframeToMs, type Timeframe } from '@tt/shared';
import { createCandlesRepository } from '../db/repositories/candles.repo.js';
import { createGapsRepository } from '../db/repositories/gaps.repo.js';
import type { SocketState } from './ws/resilient-socket.js';

export const DEFAULT_STALE_FACTOR = 2;

export type IngestStatus = 'ok' | 'degraded';

export interface HealthSeries {
  symbol: string;
  timeframe: Timeframe;
}

export interface SeriesHealth {
  symbol: string;
  timeframe: Timeframe;
  lastCandleTs: number | null;
  lastCandleAgeSec: number | null;
  staleAfterSec: number;
  stale: boolean;
  openGaps: number;
}

export interface IngestHealth {
  status: IngestStatus;
  socketState: SocketState;
  reconnects: number;
  consecutiveFailures: number;
  openGaps: number;
  staleSeries: number;
  series: SeriesHealth[];
  checkedAt: number;
}

export interface IngestHealthOptions {
  pool: Pool;
  series: readonly HealthSeries[];
  exchange?: string | undefined;
  socketState?: SocketState;
  reconnects?: number;
  consecutiveFailures?: number;
  staleFactor?: number;
  now?: () => number;
}

export async function getIngestHealth(options: IngestHealthOptions): Promise<IngestHealth> {
  const {
    pool,
    series,
    socketState = 'idle',
    reconnects = 0,
    consecutiveFailures = 0,
    staleFactor = DEFAULT_STALE_FACTOR,
    now = Date.now,
  } = options;

  const candles = createCandlesRepository(pool);
  const gaps = createGapsRepository(pool);
  const checkedAt = now();
  const reports: SeriesHealth[] = [];

  for (const item of series) {
    const ref = { exchange: options.exchange, symbol: item.symbol, timeframe: item.timeframe };
    const lastCandleTs = await candles.getLastCandleTs(ref);
    const openGaps = (await gaps.listOpen(ref)).length;

    const staleAfterMs = staleFactor * timeframeToMs(item.timeframe);
    const ageMs = lastCandleTs === null ? null : Math.max(0, checkedAt - lastCandleTs);

    reports.push({
      symbol: item.symbol,
      timeframe: item.timeframe,
      lastCandleTs,
      lastCandleAgeSec: ageMs === null ? null : Math.floor(ageMs / 1000),
      staleAfterSec: Math.floor(staleAfterMs / 1000),
      stale: ageMs === null || ageMs > staleAfterMs,
      openGaps,
    });
  }

  const staleSeries = reports.filter((report) => report.stale).length;

  return {
    status: socketState === 'open' && staleSeries === 0 ? 'ok' : 'degraded',
    socketState,
    reconnects,
    consecutiveFailures,
    openGaps: reports.reduce((total, report) => total + report.openGaps, 0),
    staleSeries,
    series: reports,
    checkedAt,
  };
}
