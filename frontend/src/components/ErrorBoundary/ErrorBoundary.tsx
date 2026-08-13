import { Component, type ErrorInfo, type ReactNode } from 'react';
import styles from './ErrorBoundary.module.css';

export interface ErrorBoundaryProps {
  readonly children: ReactNode;
  readonly onReload?: (() => void) | undefined;
  readonly onError?: ((error: Error, info: ErrorInfo) => void) | undefined;
}

export interface ErrorBoundaryState {
  readonly error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info);
  }

  private readonly reload = (): void => {
    const { onReload } = this.props;
    if (onReload === undefined) {
      globalThis.location.reload();
      return;
    }
    onReload();
  };

  private readonly retry = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;

    if (error === null) {
      return this.props.children;
    }

    return (
      <div className={styles.boundary} role="alert">
        <h1 className={styles.title}>La interfaz ha fallado</h1>
        <p className={styles.text}>
          Un error de render ha interrumpido la vista. Nada de lo que hay en el servidor se ha
          tocado: los runs y las velas siguen donde estaban.
        </p>
        <p className={styles.detail}>{error.message}</p>
        <div className={styles.actions}>
          <button type="button" className={styles.primary} onClick={this.reload}>
            Recargar la terminal
          </button>
          <button type="button" className={styles.secondary} onClick={this.retry}>
            Reintentar sin recargar
          </button>
        </div>
      </div>
    );
  }
}
