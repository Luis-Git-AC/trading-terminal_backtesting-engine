import type { StrategyParam } from '@tt/shared';
import { cx } from '@/lib/cx';
import { paramStep, type ParamValue } from '@/components/StrategyPanel/validation';
import styles from './StrategyPanel.module.css';

export interface ParamFieldProps {
  readonly param: StrategyParam;
  readonly value: ParamValue;
  readonly error: string | undefined;
  readonly onChange: (value: ParamValue) => void;
}

export function ParamField({ param, value, error, onChange }: ParamFieldProps) {
  const id = `param-${param.key}`;
  const errorId = `${id}-error`;
  const label = param.label ?? param.key;
  const describedBy = error === undefined ? undefined : errorId;

  if (param.type === 'bool') {
    return (
      <div className={styles.field}>
        <label className={styles.checkboxRow} htmlFor={id}>
          <input
            id={id}
            type="checkbox"
            checked={value === true}
            onChange={(event) => {
              onChange(event.target.checked);
            }}
          />
          <span className={styles.label}>{label}</span>
        </label>
      </div>
    );
  }

  if (param.type === 'enum') {
    return (
      <div className={styles.field}>
        <label className={styles.label} htmlFor={id}>
          {label}
        </label>
        <select
          id={id}
          className={cx(styles.control, error !== undefined && styles.controlInvalid)}
          value={String(value)}
          aria-invalid={error !== undefined}
          aria-describedby={describedBy}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        >
          {(param.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        {error !== undefined && (
          <p className={styles.error} id={errorId}>
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type="number"
        className={cx(styles.control, styles.number, error !== undefined && styles.controlInvalid)}
        value={String(value)}
        min={param.min}
        max={param.max}
        step={paramStep(param)}
        aria-invalid={error !== undefined}
        aria-describedby={describedBy}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
      {error !== undefined && (
        <p className={styles.error} id={errorId}>
          {error}
        </p>
      )}
    </div>
  );
}
