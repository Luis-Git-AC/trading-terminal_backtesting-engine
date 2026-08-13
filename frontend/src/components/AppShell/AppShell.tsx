import { Outlet } from 'react-router';
import { AppHeader } from '@/components/AppShell/AppHeader';
import styles from './AppShell.module.css';

export function AppShell() {
  return (
    <div className={styles.shell}>
      <AppHeader />
      <main className={styles.main}>
        <Outlet />
      </main>
      <div className={styles.unsupported}>
        <p className={styles.unsupportedTitle}>Ventana demasiado estrecha</p>
        <p className={styles.unsupportedText}>
          La terminal esta disenada para escritorio a partir de 1280 px. Por debajo de 960 px no se
          da soporte: amplia la ventana para seguir.
        </p>
      </div>
    </div>
  );
}
