import { useState } from 'react';
import type { CreateBacktestBody, StrategyMeta, Timeframe } from '@tt/shared';
import { describeApiError, type ApiError } from '@/api/errors';
import { ParamField } from '@/components/StrategyPanel/ParamField';
import {
  EXEC_DEFAULTS,
  EXEC_FIELDS,
  EXEC_LIMITS,
  defaultParams,
  isoDay,
  randomSeed,
  validateForm,
  type ExecField,
  type FormState,
  type ParamValue,
} from '@/components/StrategyPanel/validation';
import { useCoverage } from '@/hooks/useMarkets';
import { useStrategies } from '@/hooks/useStrategies';
import { cx } from '@/lib/cx';
import styles from './StrategyPanel.module.css';

export interface StrategyPanelProps {
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly onSubmit: (body: CreateBacktestBody) => void;
  readonly submitting?: boolean | undefined;
  readonly submitError?: ApiError | null | undefined;
}

const EMPTY_FORM: FormState = {
  strategyId: '',
  params: {},
  exec: EXEC_DEFAULTS,
  seed: '',
  from: '',
  to: '',
  label: '',
};

function serverFieldErrors(error: ApiError | null | undefined): Record<string, string> {
  const mapped: Record<string, string> = {};
  for (const detail of error?.details ?? []) {
    mapped[detail.path.replace(/^body\./, '')] = detail.message;
  }
  return mapped;
}

export function StrategyPanel({
  symbol,
  timeframe,
  onSubmit,
  submitting = false,
  submitError = null,
}: StrategyPanelProps) {
  const catalog = useStrategies();
  const coverage = useCoverage(symbol, timeframe);

  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  const strategies = catalog.data?.strategies ?? [];
  const selected: StrategyMeta | undefined =
    strategies.find((strategy) => strategy.id === form.strategyId) ?? strategies[0];

  const [syncedFor, setSyncedFor] = useState<string | null>(null);
  const coverageKey = `${symbol}:${timeframe}:${coverage.data?.from ?? ''}:${coverage.data?.to ?? ''}`;
  const syncKey = `${selected?.id ?? ''}|${coverageKey}`;

  if (selected !== undefined && syncedFor !== syncKey) {
    setSyncedFor(syncKey);
    setForm((current) => ({
      ...current,
      strategyId: selected.id,
      params: defaultParams(selected),
      from: current.from === '' ? isoDay(coverage.data?.from ?? null) : current.from,
      to: current.to === '' ? isoDay(coverage.data?.to ?? null) : current.to,
    }));
  }

  const result = validateForm(form, selected, coverage.data, symbol, timeframe);
  const fromServer = serverFieldErrors(submitError);
  const errors = { ...result.errors, ...fromServer };
  const blocked = result.body === null || submitting;

  const setParam = (key: string, value: ParamValue): void => {
    setForm((current) => ({ ...current, params: { ...current.params, [key]: value } }));
  };

  const setExec = (field: ExecField, value: string): void => {
    setForm((current) => ({ ...current, exec: { ...current.exec, [field]: value } }));
  };

  if (catalog.isPending) {
    return <p className={styles.note}>Cargando estrategias…</p>;
  }

  if (catalog.error !== null) {
    return <p className={styles.error}>{describeApiError(catalog.error)}</p>;
  }

  return (
    <form
      className={styles.panel}
      onSubmit={(event) => {
        event.preventDefault();
        if (result.body !== null && !submitting) {
          onSubmit(result.body);
        }
      }}
    >
      <section className={styles.section}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="strategy">
            Estrategia
          </label>
          <select
            id="strategy"
            className={styles.control}
            value={selected?.id ?? ''}
            onChange={(event) => {
              setForm((current) => ({ ...current, strategyId: event.target.value }));
            }}
          >
            {strategies.map((strategy) => (
              <option key={strategy.id} value={strategy.id}>
                {strategy.name}
              </option>
            ))}
          </select>
          {selected !== undefined && <p className={styles.note}>{selected.description}</p>}
        </div>

        {selected?.params.map((param) => (
          <ParamField
            key={`${selected.id}:${param.key}`}
            param={param}
            value={form.params[param.key] ?? param.default}
            error={errors[`params.${param.key}`]}
            onChange={(value) => {
              setParam(param.key, value);
            }}
          />
        ))}
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Ejecucion</h3>

        {EXEC_FIELDS.map((field) => {
          const limits = EXEC_LIMITS[field];
          const error = errors[`exec.${field}`];
          return (
            <div className={styles.field} key={field}>
              <label className={styles.label} htmlFor={`exec-${field}`}>
                {limits.label}
              </label>
              <input
                id={`exec-${field}`}
                type="number"
                className={cx(
                  styles.control,
                  styles.number,
                  error !== undefined && styles.controlInvalid,
                )}
                value={form.exec[field]}
                min={limits.min}
                max={limits.max}
                step={limits.step}
                aria-invalid={error !== undefined}
                onChange={(event) => {
                  setExec(field, event.target.value);
                }}
              />
              {error !== undefined && <p className={styles.error}>{error}</p>}
            </div>
          );
        })}

        <div className={styles.field}>
          <label className={styles.label} htmlFor="seed">
            Semilla
          </label>
          <div className={styles.seedRow}>
            <input
              id="seed"
              className={cx(
                styles.control,
                styles.number,
                errors.seed !== undefined && styles.controlInvalid,
              )}
              value={form.seed}
              inputMode="numeric"
              placeholder="la genera el servidor"
              aria-invalid={errors.seed !== undefined}
              onChange={(event) => {
                setForm((current) => ({ ...current, seed: event.target.value }));
              }}
            />
            <button
              type="button"
              className={styles.ghostButton}
              onClick={() => {
                setForm((current) => ({ ...current, seed: String(randomSeed()) }));
              }}
            >
              Aleatoria
            </button>
          </div>
          {errors.seed !== undefined && <p className={styles.error}>{errors.seed}</p>}
        </div>
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Rango</h3>

        <div className={styles.rangeRow}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="from">
              Desde
            </label>
            <input
              id="from"
              type="date"
              className={cx(styles.control, errors.range !== undefined && styles.controlInvalid)}
              value={form.from}
              min={isoDay(coverage.data?.from ?? null)}
              max={isoDay(coverage.data?.to ?? null)}
              onChange={(event) => {
                setForm((current) => ({ ...current, from: event.target.value }));
              }}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="to">
              Hasta
            </label>
            <input
              id="to"
              type="date"
              className={cx(styles.control, errors.range !== undefined && styles.controlInvalid)}
              value={form.to}
              min={isoDay(coverage.data?.from ?? null)}
              max={isoDay(coverage.data?.to ?? null)}
              onChange={(event) => {
                setForm((current) => ({ ...current, to: event.target.value }));
              }}
            />
          </div>
        </div>

        {coverage.data !== undefined && (
          <p className={styles.note}>
            Cobertura: {isoDay(coverage.data.from)} a {isoDay(coverage.data.to)} ·{' '}
            {coverage.data.candles.toLocaleString('es-ES')} velas
          </p>
        )}
        {errors.range !== undefined && <p className={styles.error}>{errors.range}</p>}
        {result.warnings.map((warning) => (
          <p className={styles.warning} key={warning}>
            {warning}
          </p>
        ))}

        <div className={styles.field}>
          <label className={styles.label} htmlFor="label">
            Etiqueta
          </label>
          <input
            id="label"
            className={cx(styles.control, errors.label !== undefined && styles.controlInvalid)}
            value={form.label}
            placeholder="opcional"
            onChange={(event) => {
              setForm((current) => ({ ...current, label: event.target.value }));
            }}
          />
          {errors.label !== undefined && <p className={styles.error}>{errors.label}</p>}
        </div>
      </section>

      <div className={styles.actions}>
        <button type="submit" className={styles.submit} disabled={blocked}>
          {submitting ? 'Lanzando…' : 'Ejecutar backtest'}
        </button>
        {blocked && !submitting && (
          <p className={styles.error} role="status">
            {Object.values(errors)[0] ?? 'Revisa los parametros'}
          </p>
        )}
        {submitError !== null && submitError.details === undefined && (
          <p className={styles.error}>{describeApiError(submitError)}</p>
        )}
      </div>
    </form>
  );
}
