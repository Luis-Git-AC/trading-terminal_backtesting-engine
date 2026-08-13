import { describe, expect, it } from 'vitest';
import { RUN_STATUSES } from '@tt/shared';
import {
  RUN_STATUS_LABEL,
  barsLabel,
  formatEta,
  formatPct,
  formatQuote,
  isCancellable,
} from '@/components/RunProgress/format';

describe('RUN_STATUS_LABEL', () => {
  it('cubre los cinco estados del contrato', () => {
    expect(Object.keys(RUN_STATUS_LABEL).sort()).toEqual([...RUN_STATUSES].sort());
  });
});

describe('isCancellable', () => {
  it('solo se puede cancelar lo que aun no ha terminado', () => {
    expect(isCancellable('queued')).toBe(true);
    expect(isCancellable('running')).toBe(true);
    expect(isCancellable('completed')).toBe(false);
    expect(isCancellable('failed')).toBe(false);
    expect(isCancellable('cancelled')).toBe(false);
    expect(isCancellable(undefined)).toBe(false);
  });
});

describe('formatPct', () => {
  it('redondea a un decimal', () => {
    expect(formatPct(0)).toBe('0.0%');
    expect(formatPct(34.219)).toBe('34.2%');
    expect(formatPct(100)).toBe('100.0%');
  });
});

describe('formatEta', () => {
  it('sin estimacion muestra una raya', () => {
    expect(formatEta(null)).toBe('—');
  });

  it('por debajo del segundo no dice 0s', () => {
    expect(formatEta(300)).toBe('<1s');
  });

  it('usa segundos y minutos segun la magnitud', () => {
    expect(formatEta(2600)).toBe('3s');
    expect(formatEta(45_000)).toBe('45s');
    expect(formatEta(90_000)).toBe('1m 30s');
    expect(formatEta(600_000)).toBe('10m 0s');
  });
});

describe('formatQuote', () => {
  it('formatea el importe que llega como string del contrato', () => {
    expect(formatQuote('10480.2')).toBe('10.480,20');
  });

  it('sin valor muestra una raya', () => {
    expect(formatQuote(undefined)).toBe('—');
  });

  it('si no es un numero lo deja tal cual en vez de mostrar NaN', () => {
    expect(formatQuote('vete a saber')).toBe('vete a saber');
  });
});

describe('barsLabel', () => {
  it('muestra hechas sobre totales', () => {
    expect(barsLabel(5975, 17_472)).toBe('5.975 / 17.472');
  });

  it('sin total conocido muestra solo las hechas', () => {
    expect(barsLabel(120, null)).toBe('120');
    expect(barsLabel(120, 0)).toBe('120');
  });
});
