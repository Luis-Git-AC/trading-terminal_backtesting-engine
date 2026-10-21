import type { StrategyParam } from '@tt/shared';
import { cx } from '@/lib/cx';
import { NumberStepper } from '@/components/StrategyPanel/NumberStepper';
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
      <label className={styles.toggleRow} htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          role="switch"
          className={styles.toggle}
          checked={value === true}
          onChange={(event) => {
            onChange(event.target.checked);
          }}
        />
        <span className={styles.label}>{label}</span>
      </label>
    );
  }

  if (param.type === 'enum') {
    return (
      <fieldset className={cx(styles.choice, styles.fieldWide)}>
        <legend className={cx(styles.label, styles.legend)}>{label}</legend>
        <div className={styles.segments}>
          {(param.options ?? []).map((option) => {
            const active = String(value) === option;
            return (
              <label key={option} className={cx(styles.segment, active && styles.segmentActive)}>
                <input
                  type="radio"
                  name={id}
                  value={option}
                  checked={active}
                  className={styles.segmentRadio}
                  aria-describedby={describedBy}
                  onChange={() => {
                    onChange(option);
                  }}
                />
                <span>{option}</span>
              </label>
            );
          })}
        </div>
        {error !== undefined && (
          <p className={styles.error} id={errorId}>
            {error}
          </p>
        )}
      </fieldset>
    );
  }

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id} title={label}>
        {label}
      </label>
      <NumberStepper
        id={id}
        name={label}
        value={String(value)}
        step={paramStep(param)}
        min={param.min}
        max={param.max}
        invalid={error !== undefined}
        describedBy={describedBy}
        onChange={onChange}
      />
      {error !== undefined && (
        <p className={styles.error} id={errorId}>
          {error}
        </p>
      )}
    </div>
  );
}
