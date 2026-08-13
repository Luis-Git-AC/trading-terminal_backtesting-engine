import { describeApiError } from '@/api/errors';
import { CandleChart } from '@/components/Chart/CandleChart';
import { Panel } from '@/components/Panel/Panel';
import { useCandleWindow } from '@/hooks/useCandleWindow';
import { useMarketSelection } from '@/state/market-selection';
import styles from './Terminal.module.css';

export function Terminal() {
  const { symbol, timeframe } = useMarketSelection();

  const { candles, isPending, error, bars, canLoadOlder, loadOlder } = useCandleWindow(
    symbol,
    timeframe,
  );

  return (
    <div className={styles.workspace}>
      <Panel title="Parametros" className={styles.params}>
        <p className={styles.pending}>
          Formulario de estrategia y ejecucion, generado desde el catalogo del API. Llega en F5-T5.
        </p>
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
        <p className={styles.pending}>
          Metricas, curva de equity y tabla de trades del run seleccionado. Llega en F5-T7.
        </p>
      </Panel>
    </div>
  );
}
