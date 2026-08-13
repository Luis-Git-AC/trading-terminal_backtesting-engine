import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import type { BacktestTrade } from '@tt/shared';
import { CandleChart } from '@/components/Chart/CandleChart';
import { EmptyState } from '@/components/Feedback/EmptyState';
import { ErrorState } from '@/components/Feedback/ErrorState';
import { Skeleton } from '@/components/Feedback/Skeleton';
import { Panel } from '@/components/Panel/Panel';
import { RunProgress } from '@/components/RunProgress/RunProgress';
import { RunResults } from '@/components/Results/RunResults';
import { tradeRange } from '@/components/Results/trades';
import { StrategyPanel } from '@/components/StrategyPanel/StrategyPanel';
import { useCandleWindow } from '@/hooks/useCandleWindow';
import { useCreateBacktest } from '@/hooks/useBacktest';
import { useRun, useRunTrades } from '@/hooks/useRuns';
import { cx } from '@/lib/cx';
import { useLiveStatus } from '@/state/live-status';
import { useMarketSelection } from '@/state/market-selection';
import styles from './Terminal.module.css';

export const RUN_PARAM = 'run';
export const DUPLICATE_PARAM = 'duplicate';

export const FOCUS_PAD_MS = 30 * 60 * 1000;

type ChartPhase = 'error' | 'loading' | 'empty' | 'chart';

export function Terminal() {
  const { symbol, timeframe } = useMarketSelection();
  const [searchParams, setSearchParams] = useSearchParams();

  const runId = searchParams.get(RUN_PARAM) ?? undefined;
  const duplicateId = searchParams.get(DUPLICATE_PARAM) ?? undefined;

  const { candles, isPending, error, bars, canLoadOlder, loadOlder, isRefetching, refetch } =
    useCandleWindow(symbol, timeframe);

  const [focused, setFocused] = useState<BacktestTrade | null>(null);

  const { setCandleStream } = useLiveStatus();

  const chartPhase: ChartPhase =
    error !== null ? 'error' : isPending ? 'loading' : candles.length === 0 ? 'empty' : 'chart';

  useEffect(() => {
    if (chartPhase !== 'chart') {
      setCandleStream('disconnected');
    }
  }, [chartPhase, setCandleStream]);

  const createBacktest = useCreateBacktest();
  const run = useRun(runId);
  const duplicated = useRun(duplicateId);
  const completed = run.data?.status === 'completed';
  const trades = useRunTrades(completed && runId !== undefined ? { runId } : undefined);

  const showsThisSeries =
    run.data?.symbol === symbol && run.data.timeframe === timeframe
      ? trades.data?.trades
      : undefined;

  const selectRun = (next: string | undefined): void => {
    setSearchParams(
      (current) => {
        const params = new URLSearchParams(current);
        if (next === undefined) {
          params.delete(RUN_PARAM);
        } else {
          params.set(RUN_PARAM, next);
        }
        return params;
      },
      { replace: true },
    );
  };

  return (
    <div className={styles.workspace}>
      <Panel title="Parametros" className={styles.params}>
        <StrategyPanel
          symbol={symbol}
          timeframe={timeframe}
          submitting={createBacktest.isPending}
          submitError={createBacktest.error}
          preset={duplicated.data}
          onSubmit={(body) => {
            createBacktest.mutate(body, {
              onSuccess: (created) => {
                selectRun(created.runId);
              },
            });
          }}
        />
      </Panel>

      <Panel
        title="Grafico"
        meta={`${symbol} · ${timeframe} · ${String(candles.length)}/${String(bars)}`}
        className={styles.chart}
        scroll={false}
      >
        <div
          className={cx(
            styles.chartSurface,
            chartPhase === 'loading' && styles.chartSurfaceStretch,
            (chartPhase === 'error' || chartPhase === 'empty') && styles.chartSurfacePadded,
          )}
        >
          {chartPhase === 'error' ? (
            <ErrorState
              error={error}
              title={`No se han podido cargar las velas de ${symbol} ${timeframe}`}
              centered
              retrying={isRefetching}
              onRetry={refetch}
            />
          ) : chartPhase === 'loading' ? (
            <Skeleton
              label={`Cargando velas de ${symbol} ${timeframe}…`}
              lines={1}
              variant="block"
            />
          ) : chartPhase === 'empty' ? (
            <EmptyState
              centered
              title={`Aun no hay datos para ${timeframe}`}
              hint={`La base de datos no tiene ninguna vela de ${symbol} en ${timeframe}. Rellena el historico y vuelve a esta vista.`}
              command={`npm run backfill -- --symbol ${symbol} --timeframe ${timeframe}`}
            />
          ) : (
            <CandleChart
              symbol={symbol}
              timeframe={timeframe}
              candles={candles}
              trades={showsThisSeries}
              live
              onLoadOlder={canLoadOlder ? loadOlder : undefined}
              focus={focused === null ? undefined : tradeRange(focused, FOCUS_PAD_MS)}
              onConnectionChange={setCandleStream}
            />
          )}
        </div>
      </Panel>

      <Panel title="Resultados" className={styles.results}>
        <RunProgress
          runId={runId}
          onDismiss={() => {
            selectRun(undefined);
          }}
        />
        <RunResults
          runId={runId}
          selectedSeq={focused?.seq}
          onSelectTrade={(trade) => {
            setFocused(trade);
          }}
        />
      </Panel>
    </div>
  );
}
