import type { Pool } from 'pg';
import { alignTs, type Timeframe } from '@tt/shared';
import { createCandlesRepository } from '../db/repositories/candles.repo.js';
import { createGapsRepository, type GapRecord } from '../db/repositories/gaps.repo.js';

export const DEFAULT_GAP_SCAN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface ScanSeries {
  symbol: string;
  timeframe: Timeframe;
}

export interface GapScanOptions {
  pool: Pool;
  series: readonly ScanSeries[];
  exchange?: string | undefined;
  windowMs?: number;
  to?: number | undefined;
  now?: () => number;
  log?: GapScanLogger;
}

export interface SeriesScanReport {
  symbol: string;
  timeframe: Timeframe;
  fromTs: number;
  toTs: number;
  found: number;
  recorded: number;
  suppressed: number;
  missing: number;
}

export interface GapScanReport {
  series: SeriesScanReport[];
  found: number;
  recorded: number;
  suppressed: number;
  elapsedMs: number;
}

export type GapScanEvent =
  | { kind: 'series'; report: SeriesScanReport }
  | { kind: 'recorded'; gap: GapRecord }
  | { kind: 'finish'; report: GapScanReport };

export type GapScanLogger = (event: GapScanEvent) => void;

export async function scanGaps(options: GapScanOptions): Promise<GapScanReport> {
  const {
    pool,
    series,
    windowMs = DEFAULT_GAP_SCAN_WINDOW_MS,
    now = Date.now,
    log = (): void => undefined,
  } = options;

  const startedAt = now();
  const candles = createCandlesRepository(pool);
  const gaps = createGapsRepository(pool);
  const reports: SeriesScanReport[] = [];

  for (const { symbol, timeframe } of series) {
    const ref = { exchange: options.exchange, symbol, timeframe };
    const toTs = alignTs(options.to ?? now(), timeframe);
    const fromTs = alignTs(Math.max(0, toTs - windowMs), timeframe);

    const found = await candles.findGaps({ ...ref, from: fromTs, to: toTs });
    const noData = new Set(await gaps.listNoDataFrom(ref));

    let recorded = 0;
    let suppressed = 0;
    let missing = 0;

    for (const gap of found) {
      missing += gap.missing;

      if (noData.has(gap.fromTs)) {
        suppressed += 1;
        continue;
      }

      const stored = await gaps.recordGap({ ...ref, fromTs: gap.fromTs, toTs: gap.toTs });
      recorded += 1;
      log({ kind: 'recorded', gap: stored });
    }

    const report: SeriesScanReport = {
      symbol,
      timeframe,
      fromTs,
      toTs,
      found: found.length,
      recorded,
      suppressed,
      missing,
    };
    reports.push(report);
    log({ kind: 'series', report });
  }

  const report: GapScanReport = {
    series: reports,
    found: reports.reduce((total, item) => total + item.found, 0),
    recorded: reports.reduce((total, item) => total + item.recorded, 0),
    suppressed: reports.reduce((total, item) => total + item.suppressed, 0),
    elapsedMs: now() - startedAt,
  };

  log({ kind: 'finish', report });
  return report;
}
