import { Panel } from '@/components/Panel/Panel';
import { useMarketSelection } from '@/state/market-selection';
import styles from './Terminal.module.css';

export function Terminal() {
  const { symbol, timeframe } = useMarketSelection();

  return (
    <div className={styles.workspace}>
      <Panel title="Parametros" className={styles.params}>
        <p className={styles.pending}>
          Formulario de estrategia y ejecucion, generado desde el catalogo del API. Llega en F5-T5.
        </p>
      </Panel>

      <Panel
        title="Grafico"
        meta={`${symbol} · ${timeframe}`}
        className={styles.chart}
        scroll={false}
      >
        <div className={styles.chartSurface}>
          <p className={styles.pending}>Velas, volumen y marcadores de trades. Llega en F5-T4.</p>
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
