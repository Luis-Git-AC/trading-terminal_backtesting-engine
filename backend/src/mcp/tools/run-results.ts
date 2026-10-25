import {
  MCP_SAMPLE_POINTS,
  MCP_SAMPLE_TRADES,
  compareRunsInputSchema,
  getRunMetricsInputSchema,
  isEmptyBlackout,
  type BacktestWarning,
  type CompareResponse,
  type RunDetail,
  type RunSummary,
  type TradesResponse,
} from '@tt/shared';
import {
  compareBacktests,
  getBacktest,
  getBacktestTrades,
} from '../../api/services/backtests.service.js';
import { downsampleEquity } from '../../engine/metrics.js';
import { requireBacktests, type McpToolDeps } from './deps.js';

export interface Sampled<T> {
  readonly total: number;
  readonly sample: readonly T[];
}

export type McpRunWarning = 'event-blackout-empty';

export interface RunMetricsResult {
  readonly run: RunDetail;
  readonly warnings: readonly McpRunWarning[];
  readonly trades: Sampled<TradesResponse['trades'][number]> | null;
  readonly equity: Sampled<{ t: number; equity: string; dd: number }> | null;
}

export type McpCompareWarning = BacktestWarning | 'exchange-mismatch';

type CurvePoint = CompareResponse['curves'][number]['points'][number];

export interface CompareRunsResult {
  readonly runs: readonly RunSummary[];
  readonly curves: readonly ({ runId: string } & Sampled<CurvePoint>)[];
  readonly warnings: readonly McpCompareWarning[];
}

export function sampleEvenly<T>(points: readonly T[], max: number): T[] {
  if (points.length <= max) return [...points];
  const step = (points.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => points[Math.round(i * step)]).filter(
    (point): point is T => point !== undefined,
  );
}

export async function getRunMetricsTool(
  deps: McpToolDeps,
  input: unknown,
): Promise<RunMetricsResult> {
  const { runId } = getRunMetricsInputSchema.parse(input);
  const { service } = requireBacktests(deps);
  const run = await getBacktest(service, runId);

  if (run.status !== 'completed') return { run, warnings: [], trades: null, equity: null };

  const [trades, equity] = await Promise.all([
    getBacktestTrades(service, runId, { limit: MCP_SAMPLE_TRADES }),
    service.runs.getEquity(runId),
  ]);

  return {
    run,
    warnings: isEmptyBlackout(run.exec) ? ['event-blackout-empty'] : [],
    trades: { total: run.metrics?.trades ?? trades.trades.length, sample: trades.trades },
    equity: {
      total: equity.length,
      sample: downsampleEquity(equity, MCP_SAMPLE_POINTS).map((point) => ({
        t: point.t,
        equity: String(point.equity),
        dd: point.drawdown,
      })),
    },
  };
}

export async function compareRunsTool(
  deps: McpToolDeps,
  input: unknown,
): Promise<CompareRunsResult> {
  const { runIds } = compareRunsInputSchema.parse(input);
  const result = await compareBacktests(requireBacktests(deps).service, runIds);
  const exchanges = new Set(result.runs.map((run) => run.exchange));

  return {
    runs: result.runs,
    curves: result.curves.map((curve) => ({
      runId: curve.runId,
      total: curve.points.length,
      sample: sampleEvenly(curve.points, MCP_SAMPLE_POINTS),
    })),
    warnings: exchanges.size > 1 ? [...result.warnings, 'exchange-mismatch'] : result.warnings,
  };
}
