import { Panel } from '@/components/Panel/Panel';
import styles from './Runs.module.css';

export function Runs() {
  return (
    <div className={styles.page}>
      <Panel title="Historial de runs" className={styles.history}>
        <p className={styles.pending}>
          Lista de runs con filtros, y comparador de 2 a 4 runs con curvas superpuestas. Llega en
          F5-T8.
        </p>
      </Panel>
    </div>
  );
}
