import {
  type BlockedWindow,
  isAligned,
  isSymbolInSession,
  timeframeToMs,
  type Candle,
  type Timeframe,
} from '@tt/shared';
import { MAX_CANDLES_LIMIT, type CandlesRepository } from '../db/repositories/candles.repo.js';
import { MAX_EVENTS_LIMIT, type EventsRepository } from '../db/repositories/events.repo.js';
import type { RunRecord } from '../db/repositories/runs.repo.js';
import type { ExecConfig } from '../engine/types.js';

export const DEFAULT_CHUNK_BARS = 50_000;

export class UnalignedCandleError extends Error {
  override readonly name = 'UnalignedCandleError';
  readonly ts: number;
  readonly timeframe: Timeframe;

  constructor(ts: number, timeframe: Timeframe) {
    super(`La vela ${ts} no esta alineada al timeframe ${timeframe}.`);
    this.ts = ts;
    this.timeframe = timeframe;
  }
}

export class UnorderedCandleError extends Error {
  override readonly name = 'UnorderedCandleError';
  readonly ts: number;
  readonly previousTs: number;

  constructor(ts: number, previousTs: number) {
    super(`La vela ${ts} no avanza respecto a la anterior (${previousTs}).`);
    this.ts = ts;
    this.previousTs = previousTs;
  }
}

export interface LoadCandlesOptions {
  readonly candles: CandlesRepository;
  readonly exchange?: string | undefined;
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly from: number;
  readonly to: number;
  readonly chunkBars?: number | undefined;
  readonly onChunk?: ((loaded: number) => void | Promise<void>) | undefined;
}

export function chunkSize(chunkBars: number | undefined): number {
  const requested = chunkBars ?? DEFAULT_CHUNK_BARS;
  return Math.min(MAX_CANDLES_LIMIT, Math.max(1, Math.floor(requested)));
}

export async function loadCandles(options: LoadCandlesOptions): Promise<Candle[]> {
  const step = timeframeToMs(options.timeframe);
  const limit = chunkSize(options.chunkBars);
  const loaded: Candle[] = [];

  let cursor = options.from;
  let previousTs: number | null = null;

  while (cursor < options.to) {
    const page = await options.candles.getCandles({
      ...(options.exchange === undefined ? {} : { exchange: options.exchange }),
      symbol: options.symbol,
      timeframe: options.timeframe,
      from: cursor,
      to: options.to,
      limit,
    });

    if (page.length === 0) {
      break;
    }

    for (const candle of page) {
      if (!isAligned(candle.t, options.timeframe)) {
        throw new UnalignedCandleError(candle.t, options.timeframe);
      }
      if (previousTs !== null && candle.t <= previousTs) {
        throw new UnorderedCandleError(candle.t, previousTs);
      }
      previousTs = candle.t;
      // La vela no se quita de la serie: solo se marca si el subyacente estaba cerrado.
      loaded.push(isSymbolInSession(candle.t, options.symbol) ? candle : { ...candle, x: true });
    }

    await options.onChunk?.(loaded.length);

    if (page.length < limit) {
      break;
    }

    cursor = (previousTs ?? cursor) + step;
  }

  return loaded;
}

export class EventBlackoutError extends Error {
  override readonly name = 'EventBlackoutError';
}

export function mergeWindows(windows: readonly BlockedWindow[]): BlockedWindow[] {
  const sorted = [...windows].sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: BlockedWindow[] = [];
  for (const window of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && window.from <= last.to) {
      merged[merged.length - 1] = { from: last.from, to: Math.max(last.to, window.to) };
    } else {
      merged.push({ from: window.from, to: window.to });
    }
  }
  return merged;
}

export async function resolveBlockedWindows(
  events: EventsRepository | undefined,
  run: Pick<RunRecord, 'exec' | 'rangeFrom' | 'rangeTo'>,
): Promise<ExecConfig> {
  const request = run.exec.eventBlackout;
  if (request === undefined) return run.exec;
  if (events === undefined) {
    throw new EventBlackoutError(
      'El worker no tiene acceso a market_events para resolver eventBlackout',
    );
  }

  const found = await events.getEvents({
    from: run.rangeFrom - request.afterMs,
    to: run.rangeTo + request.beforeMs,
    types: request.types,
    asOf: run.rangeFrom,
    limit: MAX_EVENTS_LIMIT,
  });
  if (found.length >= MAX_EVENTS_LIMIT) {
    throw new EventBlackoutError(
      `El rango tiene ${MAX_EVENTS_LIMIT} eventos o mas de ${request.types.join(', ')}: acorta el rango o los tipos`,
    );
  }

  const derived = found.map((event) => ({
    from: Math.max(0, event.scheduledAt - request.beforeMs),
    to: event.scheduledAt + request.afterMs,
  }));

  return {
    ...run.exec,
    blockedWindows: mergeWindows([...(run.exec.blockedWindows ?? []), ...derived]),
  };
}
