import type {
  Candle,
  Exchange,
  FundingRate,
  IngestCandle,
  OpenInterestPoint,
  Timeframe,
} from '@tt/shared';
import type { RateLimiter } from '../rate-limiter.js';
import type {
  ResilientSocket,
  ResilientSocketEvent,
  SocketFactory,
} from '../ws/resilient-socket.js';

export const DISCARD_REASONS = [
  'malformed',
  'not-numeric',
  'invalid-ts',
  'unaligned',
  'invalid-candle',
] as const;

export type DiscardReason = (typeof DISCARD_REASONS)[number];

export interface DiscardedRow {
  index: number;
  reason: DiscardReason;
  detail: string;
}

export interface NormalizeResult {
  candles: IngestCandle[];
  discarded: DiscardedRow[];
}

export interface HttpHeaders {
  get(name: string): string | null;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: HttpHeaders;
  json(): Promise<unknown>;
}

export interface HttpRequestInit {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

export type FetchLike = (url: string, init?: HttpRequestInit) => Promise<HttpResponse>;

export type IngestEvent =
  | { kind: 'retry'; attempt: number; delayMs: number; reason: string }
  | { kind: 'discarded'; symbol: string; timeframe: Timeframe; rows: readonly DiscardedRow[] }
  /** Lo pedido excede el historico que guarda el exchange: se avisa en vez de devolver menos sin decirlo. */
  | { kind: 'truncated'; symbol: string; timeframe: Timeframe; detail: string };

export type IngestLogger = (event: IngestEvent) => void;

export interface HistoryCandlesQuery {
  symbol: string;
  timeframe: Timeframe;
  startTime?: number | undefined;
  endTime?: number | undefined;
  limit?: number | undefined;
}

export interface ExchangeRestClient {
  readonly limiter: RateLimiter;
  getHistoryCandles(query: HistoryCandlesQuery): Promise<IngestCandle[]>;
}

export interface ExchangeRestClientOptions {
  baseUrl?: string | undefined;
  pageLimit?: number | undefined;
  rps?: number | undefined;
  maxAttempts?: number | undefined;
  fetch?: FetchLike | undefined;
  random?: (() => number) | undefined;
  log?: IngestLogger | undefined;
}

/** Lo que el colector de F8 necesita de un exchange. Opcional en el adapter: no todos lo tienen todavia. */
export interface ExchangeDerivativesClient {
  getFundingHistory(query: DerivativesHistoryQuery): Promise<FundingRate[]>;
  getOpenInterestHistory(query: DerivativesHistoryQuery): Promise<OpenInterestPoint[]>;
  getOpenInterest(symbol: string): Promise<OpenInterestPoint>;
}

export interface DerivativesHistoryQuery {
  symbol: string;
  startTime?: number | undefined;
  endTime?: number | undefined;
  limit?: number | undefined;
}

export type ExchangeStreamEvent =
  | { kind: 'candle'; symbol: string; timeframe: Timeframe; candle: Candle; closed: boolean }
  | { kind: 'subscribed'; symbol: string; timeframe: Timeframe }
  | { kind: 'rejected'; arg: unknown; code: string; message: string }
  | { kind: 'discarded'; symbol: string; timeframe: Timeframe; rows: readonly DiscardedRow[] }
  | { kind: 'protocol'; detail: string }
  | { kind: 'socket'; event: ResilientSocketEvent };

export type ExchangeStreamListener = (event: ExchangeStreamEvent) => void;

export interface ExchangeCandleStreamOptions {
  url?: string | undefined;
  now?: (() => number) | undefined;
  createSocket?: SocketFactory | undefined;
  reconnectBaseMs?: number | undefined;
  reconnectMaxMs?: number | undefined;
  staleTimeoutMs?: number | undefined;
  heartbeatIntervalMs?: number | undefined;
  stableResetMs?: number | undefined;
  maxConsecutiveFailures?: number | undefined;
  random?: (() => number) | undefined;
}

export interface ExchangeCandleStream {
  readonly socket: ResilientSocket;
  on(listener: ExchangeStreamListener): () => void;
  connect(): void;
  subscribe(symbol: string, timeframe: Timeframe): void;
  unsubscribe(symbol: string, timeframe: Timeframe): void;
  flushExpired(nowMs?: number): void;
  close(): Promise<void>;
}

export interface ExchangeAdapter {
  readonly id: Exchange;
  readonly maxHistoryCandles: number | null;
  readonly maxPageLimit: number;
  createRestClient(options?: ExchangeRestClientOptions): ExchangeRestClient;
  createCandleStream(options?: ExchangeCandleStreamOptions): ExchangeCandleStream;
  /** Ausente mientras el exchange no tenga funding ni OI (Hyperliquid lo gana en F8-T4). */
  createDerivativesClient?(options?: ExchangeRestClientOptions): ExchangeDerivativesClient;
  normalizeSymbol(raw: string): string;
}
