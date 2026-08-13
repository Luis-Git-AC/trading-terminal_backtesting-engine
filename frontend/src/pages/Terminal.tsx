import { useSearchParams } from 'react-router';
import { describeApiError } from '@/api/errors';
import { CandleChart } from '@/components/Chart/CandleChart';
import { Panel } from '@/components/Panel/Panel';
import { RunProgress } from '@/components/RunProgress/RunProgress';
import { StrategyPanel } from '@/components/StrategyPanel/StrategyPanel';
import { useCandleWindow } from '@/hooks/useCandleWindow';
import { useCreateBacktest } from '@/hooks/useBacktest';
import { useRun, useRunTrades } from '@/hooks/useRuns';
import { useMarketSelection } from '@/state/market-selection';
import styles from './Terminal.module.css';

export const RUN_PARAM = 'run';

export function Terminal() {
  const { symbol, timeframe } = useMarketSelection();
  const [searchParams, setSearchParams] = useSearchParams();

  const runId = searchParams.get(RUN_PARAM) ?? undefined;

  const { candles, isPending, error, bars, canLoadOlder, loadOlder } = useCandleWindow(
    symbol,
    timeframe,
  );

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
        <p className={styles.pending}>
          Metricas, curva de equity y tabla de trades llegan en F5-T7.
        </p>
      </Panel>
    </div>
  );
}
