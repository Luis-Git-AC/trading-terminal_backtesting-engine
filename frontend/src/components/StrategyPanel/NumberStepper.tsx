import { cx } from '@/lib/cx';
import styles from './StrategyPanel.module.css';

function decimalsOf(step: number): number {
  const text = String(step);
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}

export function stepNumber(
  raw: string,
  delta: number,
  step: number,
  min?: number,
  max?: number,
): string {
  const parsed = Number(raw);
  const base = raw.trim() === '' || !Number.isFinite(parsed) ? (min ?? 0) : parsed;
  let next = Number((base + delta).toFixed(decimalsOf(step)));

  if (min !== undefined && next < min) {
    next = min;
  }
  if (max !== undefined && next > max) {
    next = max;
  }

  return String(next);
}

export interface NumberStepperProps {
  readonly id: string;
  readonly name: string;
  readonly value: string;
  readonly step: number;
  readonly min?: number | undefined;
  readonly max?: number | undefined;
  readonly unit?: string | undefined;
  readonly invalid?: boolean | undefined;
  readonly describedBy?: string | undefined;
  readonly onChange: (value: string) => void;
}

export function NumberStepper({
  id,
  name,
  value,
  step,
  min,
  max,
  unit,
  invalid = false,
  describedBy,
  onChange,
}: NumberStepperProps) {
  return (
    <div className={cx(styles.stepper, invalid && styles.stepperInvalid)}>
      <button
        type="button"
        className={styles.stepButton}
        aria-label={`Reducir ${name}`}
        onClick={() => {
          onChange(stepNumber(value, -step, step, min, max));
        }}
      >
        −
      </button>
      <input
        id={id}
        type="number"
        className={styles.stepInput}
        value={value}
        min={min}
        max={max}
        step={step}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
      {unit !== undefined && (
        <span className={styles.stepUnit} aria-hidden="true">
          {unit}
        </span>
      )}
      <button
        type="button"
        className={styles.stepButton}
        aria-label={`Aumentar ${name}`}
        onClick={() => {
          onChange(stepNumber(value, step, step, min, max));
        }}
      >
        +
      </button>
    </div>
  );
}
