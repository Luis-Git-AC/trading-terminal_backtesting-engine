import { describeApiError } from '@/api/errors';
import { CandleChart } from '@/components/Chart/CandleChart';
import { Panel } from '@/components/Panel/Panel';
import { StrategyPanel } from '@/components/StrategyPanel/StrategyPanel';
import { useCandleWindow } from '@/hooks/useCandleWindow';
import { useCreateBacktest } from '@/hooks/useBacktest';
import { useMarketSelection } from '@/state/market-selection';
import styles from './Terminal.module.css';

export function Terminal() {
  const { symbol, timeframe } = useMarketSelection();

  const { candles, isPending, error, bars, canLoadOlder, loadOlder } = useCandleWindow(
    symbol,
    timeframe,
  );

  const createBacktest = useCreateBacktest();

  return (
    <div className={styles.workspace}>
      <Panel title="Parametros" className={styles.params}>
        <StrategyPanel
          symbol={symbol}
          timeframe={timeframe}
          submitting={createBacktest.isPending}
          submitError={createBacktest.error}
          onSubmit={(body) => {
            createBacktest.mutate(body);
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
              live
              onLoadOlder={canLoadOlder ? loadOlder : undefined}
            />
          )}
        </div>
      </Panel>

      <Panel title="Resultados" className={styles.results}>
        {createBacktest.data !== undefined && (
          <p className={styles.launched}>
            Run <code>{createBacktest.data.runId}</code> en cola · semilla{' '}
            <strong>{createBacktest.data.seed}</strong> · {createBacktest.data.barsTotal} velas
            {createBacktest.data.warnings.length > 0
              ? ` · avisos: ${createBacktest.data.warnings.join(', ')}`
              : ''}
          </p>
        )}
        <p className={styles.pending}>
          Progreso en vivo y cancelacion llegan en F5-T6; metricas, curva de equity y tabla de
          trades en F5-T7.
        </p>
      </Panel>
    </div>
  );
}
