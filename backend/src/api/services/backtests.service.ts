import {
  RUNS_DEFAULT_LIMIT,
  TRADES_DEFAULT_LIMIT,
  expectedCandleCount,
  timeframeToMs,
  type BacktestJob,
  type BacktestMetricsResponse,
  type BacktestWarning,
  type CancelBacktestResponse,
  type CompareResponse,
  type CreateBacktestBody,
  type CreateBacktestResponse,
  type EquityResponse,
  type ListBacktestsQuery,
  type ListBacktestsResponse,
  type RunDetail,
  type RunSummary,
  type Timeframe,
  type TradesQuery,
  type TradesResponse,
} from '@tt/shared';
import { z } from 'zod';
import type { CandlesRepository } from '../../db/repositories/candles.repo.js';
import type { RunRecord, RunsRepository } from '../../db/repositories/runs.repo.js';
import { round10 } from '../../engine/num.js';
import { ENGINE_VERSION, type BacktestMetrics } from '../../engine/types.js';
import type { AppLogger } from '../../observability/logger.js';
import type { CancelFlagStore } from '../../queue/cancel-flags.js';
import { getStrategy, StrategyNotFoundError } from '../../strategies/registry.js';
import { AppError, type ErrorDetail } from '../errors.js';

export interface BacktestQueuePort {
  enqueue(job: BacktestJob): Promise<string>;
  remove(runId: string): Promise<boolean>;
}

export interface BacktestsServiceDeps {
  readonly runs: RunsRepository;
  readonly candles: CandlesRepository;
  readonly queue: BacktestQueuePort;
  readonly cancelFlags: CancelFlagStore;
  readonly logger: AppLogger;
  readonly exchange: string;
  readonly symbols: readonly string[];
  readonly timeframes: readonly Timeframe[];
  readonly maxBars: number;
  readonly generateSeed: () => number;
  readonly engineVersion?: string;
}

const paramsRecordSchema = z.record(z.string(), z.unknown());

function toIso(ts: number): string {
  return new Date(ts).toISOString();
}

function toIsoOrNull(ts: number | null): string | null {
  return ts === null ? null : toIso(ts);
}

function toMetrics(metrics: BacktestMetrics | null): BacktestMetricsResponse | null {
  if (metrics === null) {
    return null;
  }
  return {
    netProfit: String(metrics.netProfit),
    netProfitPct: metrics.netProfitPct,
    maxDrawdown: metrics.maxDrawdown,
    maxDrawdownQuote: String(metrics.maxDrawdownQuote),
    winRate: metrics.winRate,
    profitFactor: metrics.profitFactor,
    expectancyR: metrics.expectancyR,
    trades: metrics.trades,
    wins: metrics.wins,
    losses: metrics.losses,
    avgWinR: metrics.avgWinR,
    avgLossR: metrics.avgLossR,
    largestWinR: metrics.largestWinR,
    largestLossR: metrics.largestLossR,
    exposurePct: metrics.exposurePct,
    barsTotal: metrics.barsTotal,
    openAtEnd: metrics.openAtEnd,
  };
}

export function toRunSummary(run: RunRecord): RunSummary {
  return {
    id: run.id,
    status: run.status,
    symbol: run.symbol,
    timeframe: run.timeframe,
    strategyId: run.strategyId,
    label: run.label,
    seed: run.seed,
    engineVersion: run.engineVersion,
    paramsHash: run.paramsHash,
    range: { from: toIso(run.rangeFrom), to: toIso(run.rangeTo) },
    progress: { barsDone: run.barsDone, barsTotal: run.barsTotal },
    metrics: toMetrics(run.metrics),
    error: run.error,
    timings: {
      createdAt: toIso(run.createdAt),
      startedAt: toIsoOrNull(run.startedAt),
      finishedAt: toIsoOrNull(run.finishedAt),
      durationMs:
        run.startedAt === null || run.finishedAt === null
          ? null
          : Math.max(0, run.finishedAt - run.startedAt),
    },
  };
}

export function toRunDetail(run: RunRecord): RunDetail {
  return {
    ...toRunSummary(run),
    params: run.params,
    exec: run.exec,
  };
}

async function requireRun(deps: BacktestsServiceDeps, runId: string): Promise<RunRecord> {
  const run = await deps.runs.getRun(runId);
  if (run === null) {
    throw AppError.notFound(`No existe el backtest ${runId}`);
  }
  return run;
}

function resolveStrategy(strategyId: string): ReturnType<typeof getStrategy> {
  try {
    return getStrategy(strategyId);
  } catch (error) {
    if (error instanceof StrategyNotFoundError) {
      throw AppError.notFound(error.message);
    }
    throw error;
  }
}

function validateParams(
  strategy: ReturnType<typeof getStrategy>,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const result = strategy.paramsSchema.safeParse(params);
  if (!result.success) {
    const details: ErrorDetail[] = result.error.issues.map((issue) => {
      const path = issue.path.map((segment) => String(segment)).join('.');
      return {
        path: path === '' ? 'body.params' : `body.params.${path}`,
        message: issue.message,
      };
    });
    throw AppError.validation(
      `Los parametros no son validos para la estrategia "${strategy.id}"`,
      details,
    );
  }
  return paramsRecordSchema.parse(result.data);
}

async function coverageWarnings(
  deps: BacktestsServiceDeps,
  series: { symbol: string; timeframe: Timeframe },
  from: number,
  to: number,
): Promise<BacktestWarning[]> {
  const step = timeframeToMs(series.timeframe);
  const firstOpen = Math.ceil(from / step) * step;
  const lastOpen = Math.ceil(to / step) * step - step;

  const [coverage, gaps] = await Promise.all([
    deps.candles.getCoverage(series),
    deps.candles.findGaps({ ...series, from: firstOpen, to: lastOpen + step }),
  ]);

  const uncovered =
    coverage.fromTs === null ||
    coverage.toTs === null ||
    coverage.fromTs > firstOpen ||
    coverage.toTs < lastOpen;

  return gaps.length > 0 || uncovered ? ['coverage-gaps'] : [];
}

export async function createBacktest(
  deps: BacktestsServiceDeps,
  body: CreateBacktestBody,
): Promise<CreateBacktestResponse> {
  if (!deps.symbols.includes(body.symbol)) {
    throw AppError.notFound(`Simbolo no disponible: ${body.symbol}`);
  }
  if (!deps.timeframes.includes(body.timeframe)) {
    throw AppError.notFound(`Timeframe no disponible: ${body.timeframe}`);
  }

  const strategy = resolveStrategy(body.strategyId);
  const params = validateParams(strategy, body.params);

  if (body.to <= body.from) {
    throw AppError.validation('El rango del backtest esta vacio', [
      { path: 'body.to', message: 'to debe ser mayor que from' },
    ]);
  }

  const barsTotal = expectedCandleCount(body.from, body.to, body.timeframe);

  if (barsTotal === 0) {
    throw AppError.validation('El rango del backtest no contiene ninguna vela', [
      { path: 'body.to', message: 'El rango no cubre ni una vela completa del timeframe' },
    ]);
  }

  if (barsTotal > deps.maxBars) {
    throw AppError.rangeTooLarge(
      `El rango pedido son ${barsTotal} velas y el maximo es ${deps.maxBars}`,
    );
  }

  const seed = body.seed ?? deps.generateSeed();
  const warnings = await coverageWarnings(
    deps,
    { symbol: body.symbol, timeframe: body.timeframe },
    body.from,
    body.to,
  );

  const run = await deps.runs.createRun({
    exchange: deps.exchange,
    symbol: body.symbol,
    timeframe: body.timeframe,
    strategyId: strategy.id,
    params,
    exec: body.exec,
    seed,
    rangeFrom: body.from,
    rangeTo: body.to,
    engineVersion: deps.engineVersion ?? ENGINE_VERSION,
    barsTotal,
    ...(body.label === undefined ? {} : { label: body.label }),
  });

  try {
    await deps.queue.enqueue({ runId: run.id });
  } catch (error) {
    deps.logger.error({ err: error, runId: run.id }, 'no se pudo encolar el backtest');
    await deps.runs.failRun(run.id, 'No se pudo encolar el backtest');
    throw error;
  }

  return {
    runId: run.id,
    status: run.status,
    seed: run.seed,
    paramsHash: run.paramsHash,
    barsTotal,
    warnings,
  };
}

export async function listBacktests(
  deps: BacktestsServiceDeps,
  query: ListBacktestsQuery,
): Promise<ListBacktestsResponse> {
  const runs = await deps.runs.listRuns({
    ...(query.status === undefined ? {} : { status: query.status }),
    limit: query.limit ?? RUNS_DEFAULT_LIMIT,
    offset: query.offset ?? 0,
  });
  return { runs: runs.map(toRunSummary) };
}

export async function getBacktest(
  deps: BacktestsServiceDeps,
  runId: string,
): Promise<RunDetail> {
  return toRunDetail(await requireRun(deps, runId));
}

export async function getBacktestTrades(
  deps: BacktestsServiceDeps,
  runId: string,
  query: TradesQuery,
): Promise<TradesResponse> {
  await requireRun(deps, runId);
  const page = await deps.runs.getTrades(
    runId,
    query.limit ?? TRADES_DEFAULT_LIMIT,
    query.cursor ?? 0,
  );

  return {
    trades: page.trades.map((trade) => ({
      seq: trade.seq,
      side: trade.side,
      entryTs: trade.entryTs,
      entryPrice: String(trade.entryPrice),
      exitTs: trade.exitTs,
      exitPrice: String(trade.exitPrice),
      qty: String(trade.qty),
      fees: String(trade.fees),
      pnlQuote: String(trade.pnlQuote),
      pnlR: trade.pnlR,
      exitReason: trade.exitReason,
      maeR: trade.maeR,
      mfeR: trade.mfeR,
    })),
    nextCursor: page.nextCursor,
  };
}

export async function getBacktestEquity(
  deps: BacktestsServiceDeps,
  runId: string,
): Promise<EquityResponse> {
  await requireRun(deps, runId);
  const points = await deps.runs.getEquity(runId);
  return {
    points: points.map((point) => ({
      t: point.t,
      equity: String(point.equity),
      dd: point.drawdown,
    })),
  };
}

export async function compareBacktests(
  deps: BacktestsServiceDeps,
  ids: readonly string[],
): Promise<CompareResponse> {
  const runs: RunRecord[] = [];
  for (const id of ids) {
    runs.push(await requireRun(deps, id));
  }

  const curves = await Promise.all(
    runs.map(async (run) => {
      const points = await deps.runs.getEquity(run.id);
      const base = points[0]?.equity ?? 0;
      return {
        runId: run.id,
        points: points.map((point) => ({
          t: point.t,
          value: base === 0 ? 0 : round10((point.equity / base) * 100),
        })),
      };
    }),
  );

  const versions = new Set(runs.map((run) => run.engineVersion));
  const warnings: BacktestWarning[] = versions.size > 1 ? ['engine-version-mismatch'] : [];

  return { runs: runs.map(toRunSummary), curves, warnings };
}

export async function deleteBacktest(
  deps: BacktestsServiceDeps,
  runId: string,
): Promise<void> {
  const run = await requireRun(deps, runId);

  if (run.status === 'queued' || run.status === 'running') {
    await deps.cancelFlags.request(runId);
    await deps.queue.remove(runId);
  }

  const deleted = await deps.runs.deleteRun(runId);
  if (!deleted) {
    throw AppError.notFound(`No existe el backtest ${runId}`);
  }
}

export async function cancelBacktest(
  deps: BacktestsServiceDeps,
  runId: string,
): Promise<CancelBacktestResponse> {
  const run = await requireRun(deps, runId);

  if (run.status === 'queued') {
    await deps.cancelFlags.request(runId);
    await deps.queue.remove(runId);
    const cancelled = await deps.runs.cancelRun(runId);
    if (!cancelled) {
      throw new AppError('CONFLICT', `El run ${runId} ya no se puede cancelar`);
    }
    return { runId, status: 'cancelled' };
  }

  if (run.status === 'running') {
    await deps.cancelFlags.request(runId);
    return { runId, status: 'running' };
  }

  throw new AppError('CONFLICT', `El run ${runId} ya termino con estado ${run.status}`);
}
