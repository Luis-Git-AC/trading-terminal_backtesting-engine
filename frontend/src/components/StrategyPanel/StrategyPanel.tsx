import { useState } from 'react';
import type { CreateBacktestBody, Exchange, RunDetail, StrategyMeta, Timeframe } from '@tt/shared';
import type { ApiError } from '@/api/errors';
import { EmptyState } from '@/components/Feedback/EmptyState';
import { ErrorState } from '@/components/Feedback/ErrorState';
import { Skeleton } from '@/components/Feedback/Skeleton';
import { NumberStepper } from '@/components/StrategyPanel/NumberStepper';
import { ParamField } from '@/components/StrategyPanel/ParamField';
import {
  EXEC_DEFAULTS,
  EXEC_FIELDS,
  EXEC_LIMITS,
  dayStartMs,
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
import { formatCount } from '@/lib/format';
import styles from './StrategyPanel.module.css';

export interface StrategyPanelProps {
  readonly exchange: Exchange;
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly onSubmit: (body: CreateBacktestBody) => void;
  readonly submitting?: boolean | undefined;
  readonly submitError?: ApiError | null | undefined;
  readonly preset?: RunDetail | undefined;
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

const DAY_MS = 24 * 60 * 60 * 1000;

export const RANGE_PRESETS = [
  { key: 'all', label: 'Todo', days: null },
  { key: '30d', label: '30 d', days: 30 },
  { key: '7d', label: '7 d', days: 7 },
] as const;

export function presetRange(
  days: number | null,
  firstDay: string,
  lastDay: string,
): { readonly from: string; readonly to: string } | null {
  if (firstDay === '' || lastDay === '') {
    return null;
  }
  if (days === null) {
    return { from: firstDay, to: lastDay };
  }
  const from = new Date(dayStartMs(lastDay) - (days - 1) * DAY_MS).toISOString().slice(0, 10);
  return { from: from < firstDay ? firstDay : from, to: lastDay };
}

export function dayWithinCoverage(
  day: string,
  firstDay: string,
  lastDay: string,
  fallback: string,
): string {
  if (day === '') {
    return fallback;
  }
  if (firstDay === '' || lastDay === '') {
    return day;
  }
  return day < firstDay || day > lastDay ? fallback : day;
}

export function presetForm(
  current: FormState,
  strategy: StrategyMeta,
  preset: RunDetail | undefined,
  coverage: { from: string | null; to: string | null } | undefined,
): FormState {
  if (preset?.strategyId === strategy.id) {
    const params: Record<string, ParamValue> = defaultParams(strategy);
    for (const param of strategy.params) {
      const value = preset.params[param.key];
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        params[param.key] = value;
      }
    }

    return {
      strategyId: strategy.id,
      params,
      exec: {
        initialCapital: String(preset.exec.initialCapital),
        riskPerTradePct: String(preset.exec.riskPerTradePct),
        feeBps: String(preset.exec.feeBps),
        slippageBps: String(preset.exec.slippageBps),
      },
      seed: String(preset.seed),
      from: isoDay(preset.range.from),
      to: isoDay(preset.range.to),
      label: preset.label ?? '',
    };
  }

  const firstDay = isoDay(coverage?.from ?? null);
  const lastDay = isoDay(coverage?.to ?? null);

  return {
    ...current,
    strategyId: strategy.id,
    params: defaultParams(strategy),
    from: dayWithinCoverage(current.from, firstDay, lastDay, firstDay),
    to: dayWithinCoverage(current.to, firstDay, lastDay, lastDay),
  };
}

function serverFieldErrors(error: ApiError | null | undefined): Record<string, string> {
  const mapped: Record<string, string> = {};
  for (const detail of error?.details ?? []) {
    mapped[detail.path.replace(/^body\./, '')] = detail.message;
  }
  return mapped;
}

export function isSubmitShortcut(event: {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
}): boolean {
  return event.key === 'Enter' && (event.ctrlKey || event.metaKey);
}

function DiceIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <circle cx="8.5" cy="8.5" r="1" fill="currentColor" />
      <circle cx="15.5" cy="15.5" r="1" fill="currentColor" />
      <circle cx="15.5" cy="8.5" r="1" fill="currentColor" />
      <circle cx="8.5" cy="15.5" r="1" fill="currentColor" />
    </svg>
  );
}

export function StrategyPanel({
  exchange,
  symbol,
  timeframe,
  onSubmit,
  submitting = false,
  submitError = null,
  preset,
}: StrategyPanelProps) {
  const catalog = useStrategies();
  const coverage = useCoverage(exchange, symbol, timeframe);

  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  const [syncedFor, setSyncedFor] = useState<string | null>(null);

  const strategies = catalog.data?.strategies ?? [];
  const pendingPreset = preset !== undefined && !(syncedFor ?? '').endsWith(`|${preset.id}`);
  const wantedId = pendingPreset && preset !== undefined ? preset.strategyId : form.strategyId;

  const selected: StrategyMeta | undefined =
    strategies.find((strategy) => strategy.id === wantedId) ?? strategies[0];

  const coverageKey = `${symbol}:${timeframe}:${coverage.data?.from ?? ''}:${coverage.data?.to ?? ''}`;
  const syncKey = `${selected?.id ?? ''}|${coverageKey}|${preset?.id ?? ''}`;

  if (selected !== undefined && syncedFor !== syncKey) {
    setSyncedFor(syncKey);
    setForm((current) => presetForm(current, selected, preset, coverage.data));
  }

  const result = validateForm(form, selected, coverage.data, exchange, symbol, timeframe);
  const fromServer = serverFieldErrors(submitError);
  const errors = { ...result.errors, ...fromServer };
  const blocked = result.body === null || submitting;

  const firstDay = isoDay(coverage.data?.from ?? null);
  const lastDay = isoDay(coverage.data?.to ?? null);

  const setParam = (key: string, value: ParamValue): void => {
    setForm((current) => ({ ...current, params: { ...current.params, [key]: value } }));
  };

  const setExec = (field: ExecField, value: string): void => {
    setForm((current) => ({ ...current, exec: { ...current.exec, [field]: value } }));
  };

  if (catalog.isPending) {
    return <Skeleton label="Cargando estrategias…" lines={6} />;
  }

  if (catalog.error !== null) {
    return (
      <ErrorState
        error={catalog.error}
        title="No se ha podido cargar el catalogo de estrategias"
        retrying={catalog.isRefetching}
        onRetry={() => {
          void catalog.refetch();
        }}
      />
    );
  }

  if (selected === undefined) {
    return (
      <EmptyState
        title="El API no expone ninguna estrategia"
        hint="El catalogo ha respondido vacio. Comprueba que el registro de estrategias del backend esta cargado."
        command="npm run dev:api"
      />
    );
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
      onKeyDown={(event) => {
        if (isSubmitShortcut(event)) {
          event.preventDefault();
          event.currentTarget.requestSubmit();
        }
      }}
    >
      <section className={styles.section}>
        <div className={styles.choice}>
          <div className={styles.legendRow}>
            <label className={cx(styles.sectionTitle, styles.legend)} htmlFor="strategy">
              Estrategia
            </label>
            <span className={styles.help} title={selected.description} aria-hidden="true">
              ?
            </span>
          </div>
          <select
            id="strategy"
            name="strategy"
            className={styles.control}
            value={selected.id}
            aria-describedby={`strategy-${selected.id}-description`}
            onChange={(event) => {
              const strategyId = event.target.value;
              setForm((current) => ({ ...current, strategyId }));
            }}
          >
            {strategies.map((strategy) => (
              <option key={strategy.id} value={strategy.id}>
                {strategy.name}
              </option>
            ))}
          </select>
          {strategies.map((strategy) => (
            <p
              key={strategy.id}
              id={`strategy-${strategy.id}-description`}
              className={styles.srOnly}
              hidden={strategy.id !== selected.id}
            >
              {strategy.description}
            </p>
          ))}
        </div>

        <div className={styles.grid}>
          {selected.params.map((param) => (
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
        </div>
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Ejecucion</h3>

        <div className={styles.grid}>
          {EXEC_FIELDS.map((field) => {
            const limits = EXEC_LIMITS[field];
            const error = errors[`exec.${field}`];

            return (
              <div className={styles.field} key={field}>
                <label className={styles.label} htmlFor={`exec-${field}`} title={limits.label}>
                  {limits.label}
                  {limits.unit !== undefined && (
                    <span className={styles.srOnly}> ({limits.unit})</span>
                  )}
                </label>
                <NumberStepper
                  id={`exec-${field}`}
                  name={limits.label}
                  value={form.exec[field]}
                  step={limits.step}
                  min={limits.min}
                  max={limits.max}
                  unit={limits.unit}
                  invalid={error !== undefined}
                  describedBy={error === undefined ? undefined : `exec-${field}-error`}
                  onChange={(value) => {
                    setExec(field, value);
                  }}
                />
                {error !== undefined && (
                  <p className={styles.error} id={`exec-${field}-error`}>
                    {error}
                  </p>
                )}
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
                placeholder="auto"
                aria-invalid={errors.seed !== undefined}
                aria-describedby={errors.seed === undefined ? undefined : 'seed-error'}
                onChange={(event) => {
                  setForm((current) => ({ ...current, seed: event.target.value }));
                }}
              />
              <button
                type="button"
                className={styles.iconButton}
                aria-label="Aleatoria"
                title="Semilla aleatoria"
                onClick={() => {
                  setForm((current) => ({ ...current, seed: String(randomSeed()) }));
                }}
              >
                <DiceIcon />
              </button>
            </div>
            {errors.seed !== undefined && (
              <p className={styles.error} id="seed-error">
                {errors.seed}
              </p>
            )}
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="label">
              Etiqueta
            </label>
            <input
              id="label"
              className={cx(styles.control, errors.label !== undefined && styles.controlInvalid)}
              value={form.label}
              placeholder="opcional"
              aria-invalid={errors.label !== undefined}
              aria-describedby={errors.label === undefined ? undefined : 'label-error'}
              onChange={(event) => {
                setForm((current) => ({ ...current, label: event.target.value }));
              }}
            />
            {errors.label !== undefined && (
              <p className={styles.error} id="label-error">
                {errors.label}
              </p>
            )}
          </div>
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h3 className={styles.sectionTitle}>Rango</h3>
          <div className={styles.quickRange} role="group" aria-label="Rango rapido">
            {RANGE_PRESETS.map((option) => {
              const target = presetRange(option.days, firstDay, lastDay);
              const active = target !== null && target.from === form.from && target.to === form.to;

              return (
                <button
                  key={option.key}
                  type="button"
                  className={cx(styles.chip, active && styles.chipActive)}
                  aria-pressed={active}
                  onClick={() => {
                    if (target !== null) {
                      setForm((current) => ({ ...current, from: target.from, to: target.to }));
                    }
                  }}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className={styles.grid}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="from">
              Desde
            </label>
            <input
              id="from"
              type="date"
              className={cx(
                styles.control,
                styles.date,
                errors.range !== undefined && styles.controlInvalid,
              )}
              value={form.from}
              min={firstDay}
              max={lastDay}
              aria-invalid={errors.range !== undefined}
              aria-describedby={errors.range === undefined ? undefined : 'range-error'}
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
              className={cx(
                styles.control,
                styles.date,
                errors.range !== undefined && styles.controlInvalid,
              )}
              value={form.to}
              min={firstDay}
              max={lastDay}
              aria-invalid={errors.range !== undefined}
              aria-describedby={errors.range === undefined ? undefined : 'range-error'}
              onChange={(event) => {
                setForm((current) => ({ ...current, to: event.target.value }));
              }}
            />
          </div>
        </div>

        {coverage.data !== undefined && firstDay !== '' && lastDay !== '' && (
          <p className={styles.note}>
            Cobertura: {firstDay} a {lastDay} · {formatCount(coverage.data.candles)} velas
          </p>
        )}
        {errors.range !== undefined && (
          <p className={styles.error} id="range-error">
            {errors.range}
          </p>
        )}
        {result.warnings.map((warning) => (
          <p className={styles.warning} key={warning}>
            {warning}
          </p>
        ))}
      </section>

      <div className={styles.actions}>
        <button
          type="submit"
          className={styles.submit}
          disabled={blocked}
          aria-keyshortcuts="Control+Enter Meta+Enter"
        >
          {submitting ? 'Lanzando…' : 'Ejecutar backtest'}
          {!submitting && (
            <kbd className={styles.shortcut} aria-hidden="true">
              Ctrl ↵
            </kbd>
          )}
        </button>
        {blocked && !submitting && (
          <p className={styles.error} role="status">
            {Object.values(errors)[0] ?? 'Revisa los parametros'}
          </p>
        )}
        {submitError !== null && submitError.details === undefined && (
          <ErrorState error={submitError} title="No se ha podido lanzar el backtest" />
        )}
      </div>
    </form>
  );
}
