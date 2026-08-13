import { useState } from 'react';
import { useSearchParams } from 'react-router';
import type { BacktestTrade } from '@tt/shared';
import { describeApiError } from '@/api/errors';
import { CandleChart } from '@/components/Chart/CandleChart';
import { Panel } from '@/components/Panel/Panel';
import { RunProgress } from '@/components/RunProgress/RunProgress';
import { RunResults } from '@/components/Results/RunResults';
import { tradeRange } from '@/components/Results/trades';
import { StrategyPanel } from '@/components/StrategyPanel/StrategyPanel';
import { useCandleWindow } from '@/hooks/useCandleWindow';
import { useCreateBacktest } from '@/hooks/useBacktest';
import { useRun, useRunTrades } from '@/hooks/useRuns';
import { useMarketSelection } from '@/state/market-selection';
import styles from './Terminal.module.css';

export const RUN_PARAM = 'run';

export const FOCUS_PAD_MS = 30 * 60 * 1000;

export function Terminal() {
  const { symbol, timeframe } = useMarketSelection();
  const [searchParams, setSearchParams] = useSearchParams();

  const runId = searchParams.get(RUN_PARAM) ?? undefined;

  const { candles, isPending, error, bars, canLoadOlder, loadOlder } = useCandleWindow(
    symbol,
    timeframe,
  );

  const [focused, setFocused] = useState<BacktestTrade | null>(null);

  const createBacktest = useCreateBacktest();
  const run = useRun(runId);
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
        <div className={styles.chartSurface}>
          {error !== null ? (
            <p className={styles.pending}>{describeApiError(error)}</p>
          ) : isPending ? (
            <p className={styles.pending}>Cargando velas…</p>
          ) : candles.length === 0 ? (
            <p className={styles.pending}>
              No hay velas para {symbol} {timeframe}. Ejecuta el backfill o `npm run db:seed`.
            </p>
          ) : (
            <CandleChart
              symbol={symbol}
              timeframe={timeframe}
              candles={candles}
              trades={showsThisSeries}
              live
              onLoadOlder={canLoadOlder ? loadOlder : undefined}
              focus={focused === null ? undefined : tradeRange(focused, FOCUS_PAD_MS)}
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
