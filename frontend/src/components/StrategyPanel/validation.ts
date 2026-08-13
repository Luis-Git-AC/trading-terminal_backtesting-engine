import {
  SEED_MAX,
  expectedCandleCount,
  type CoverageResponse,
  type CreateBacktestBody,
  type StrategyMeta,
  type StrategyParam,
  type Timeframe,
} from '@tt/shared';

export type ParamValue = string | number | boolean;

export const EXEC_FIELDS = ['initialCapital', 'riskPerTradePct', 'feeBps', 'slippageBps'] as const;

export type ExecField = (typeof EXEC_FIELDS)[number];

export interface ExecLimits {
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly exclusiveMin: boolean;
}

export const EXEC_LIMITS: Record<ExecField, ExecLimits> = {
  initialCapital: {
    label: 'Capital inicial',
    min: 0,
    max: 1e12,
    step: 100,
    exclusiveMin: true,
  },
  riskPerTradePct: {
    label: 'Riesgo por trade (%)',
    min: 0,
    max: 100,
    step: 0.1,
    exclusiveMin: true,
  },
  feeBps: { label: 'Fee (bps)', min: 0, max: 1000, step: 0.5, exclusiveMin: false },
  slippageBps: { label: 'Slippage (bps)', min: 0, max: 1000, step: 0.5, exclusiveMin: false },
};

export const EXEC_DEFAULTS: Record<ExecField, string> = {
  initialCapital: '10000',
  riskPerTradePct: '1',
  feeBps: '6',
  slippageBps: '2',
};

export interface FormState {
  readonly strategyId: string;
  readonly params: Readonly<Record<string, ParamValue>>;
  readonly exec: Readonly<Record<ExecField, string>>;
  readonly seed: string;
  readonly from: string;
  readonly to: string;
  readonly label: string;
}

export interface ValidationResult {
  readonly errors: Readonly<Record<string, string>>;
  readonly warnings: readonly string[];
  readonly body: CreateBacktestBody | null;
}

export function paramStep(param: StrategyParam): number {
  return param.type === 'int' ? 1 : 0.01;
}

export function defaultParams(strategy: StrategyMeta): Record<string, ParamValue> {
  const defaults: Record<string, ParamValue> = {};
  for (const param of strategy.params) {
    defaults[param.key] = param.default;
  }
  return defaults;
}

export function isoDay(iso: string | null): string {
  return iso === null ? '' : (iso.slice(0, 10) ?? '');
}

export function dayStartMs(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

export function dayEndMs(day: string): number {
  return Date.parse(`${day}T23:59:59.999Z`);
}

function numberFrom(raw: ParamValue): number | null {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : null;
  }
  if (typeof raw !== 'string' || raw.trim() === '') {
    return null;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export function validateParam(param: StrategyParam, raw: ParamValue): string | null {
  if (param.type === 'bool') {
    return typeof raw === 'boolean' ? null : 'Debe ser verdadero o falso';
  }

  if (param.type === 'enum') {
    const options = param.options ?? [];
    return options.includes(String(raw)) ? null : `Debe ser uno de: ${options.join(', ')}`;
  }

  const value = numberFrom(raw);

  if (value === null) {
    return 'Hace falta un numero';
  }
  if (param.type === 'int' && !Number.isInteger(value)) {
    return 'Debe ser un entero';
  }
  if (param.min !== undefined && value < param.min) {
    return `No puede ser menor que ${String(param.min)}`;
  }
  if (param.max !== undefined && value > param.max) {
    return `No puede ser mayor que ${String(param.max)}`;
  }
  return null;
}

function validateExec(state: FormState, errors: Record<string, string>): Record<string, number> {
  const values: Record<string, number> = {};

  for (const field of EXEC_FIELDS) {
    const limits = EXEC_LIMITS[field];
    const value = numberFrom(state.exec[field]);

    if (value === null) {
      errors[`exec.${field}`] = 'Hace falta un numero';
      continue;
    }
    if (limits.exclusiveMin && value <= limits.min) {
      errors[`exec.${field}`] = `Debe ser mayor que ${String(limits.min)}`;
      continue;
    }
    if (!limits.exclusiveMin && value < limits.min) {
      errors[`exec.${field}`] = `No puede ser menor que ${String(limits.min)}`;
      continue;
    }
    if (value > limits.max) {
      errors[`exec.${field}`] = `No puede ser mayor que ${String(limits.max)}`;
      continue;
    }
    values[field] = value;
  }

  return values;
}

function validateSeed(state: FormState, errors: Record<string, string>): number | undefined {
  const raw = state.seed.trim();

  if (raw === '') {
    return undefined;
  }
  if (!/^\d+$/.test(raw)) {
    errors.seed = 'La semilla debe ser un entero no negativo';
    return undefined;
  }

  const seed = Number(raw);
  if (seed > SEED_MAX) {
    errors.seed = `La semilla no puede superar ${String(SEED_MAX)}`;
    return undefined;
  }
  return seed;
}

function validateRange(
  state: FormState,
  coverage: CoverageResponse | undefined,
  errors: Record<string, string>,
  warnings: string[],
): { from: number; to: number } | null {
  if (state.from === '' || state.to === '') {
    errors.range = 'Elige un rango de fechas';
    return null;
  }

  const from = dayStartMs(state.from);
  const to = dayEndMs(state.to);

  if (Number.isNaN(from) || Number.isNaN(to)) {
    errors.range = 'Fecha invalida';
    return null;
  }
  if (to <= from) {
    errors.range = 'La fecha final debe ser posterior a la inicial';
    return null;
  }

  if (coverage === undefined) {
    return { from, to };
  }

  if (coverage.from === null || coverage.to === null) {
    errors.range =
      'No hay velas guardadas para esta serie. Ejecuta el backfill o "npm run db:seed".';
    return null;
  }

  const firstDay = isoDay(coverage.from);
  const lastDay = isoDay(coverage.to);

  if (state.from < firstDay || state.to > lastDay) {
    errors.range = `Fuera de la cobertura disponible (${firstDay} a ${lastDay})`;
    return null;
  }

  const overlapping = coverage.gaps.filter((gap) => {
    const gapFrom = Date.parse(gap.from);
    const gapTo = Date.parse(gap.to);
    return gapFrom <= to && gapTo >= from;
  });

  if (overlapping.length > 0) {
    warnings.push(
      `El rango tiene ${String(overlapping.length)} hueco(s) de datos; el backtest los saltara.`,
    );
  }

  return { from, to };
}

export function validateForm(
  state: FormState,
  strategy: StrategyMeta | undefined,
  coverage: CoverageResponse | undefined,
  symbol: string,
  timeframe: Timeframe,
): ValidationResult {
  const errors: Record<string, string> = {};
  const warnings: string[] = [];

  if (strategy === undefined) {
    return { errors: { strategyId: 'Elige una estrategia' }, warnings, body: null };
  }

  const params: Record<string, unknown> = {};

  for (const param of strategy.params) {
    const raw = state.params[param.key] ?? param.default;
    const error = validateParam(param, raw);
    if (error !== null) {
      errors[`params.${param.key}`] = error;
      continue;
    }
    params[param.key] =
      param.type === 'bool' || param.type === 'enum' ? raw : Number(numberFrom(raw));
  }

  const exec = validateExec(state, errors);
  const seed = validateSeed(state, errors);
  const range = validateRange(state, coverage, errors, warnings);

  if (state.label.length > 120) {
    errors.label = 'La etiqueta no puede pasar de 120 caracteres';
  }

  if (Object.keys(errors).length > 0 || range === null) {
    return { errors, warnings, body: null };
  }

  const bars = expectedCandleCount(range.from, range.to, timeframe);
  if (bars <= 0) {
    return {
      errors: { range: 'El rango no contiene ninguna vela' },
      warnings,
      body: null,
    };
  }

  const label = state.label.trim();

  return {
    errors,
    warnings,
    body: {
      symbol,
      timeframe,
      from: range.from,
      to: range.to,
      strategyId: strategy.id,
      params,
      exec: {
        initialCapital: exec.initialCapital ?? 0,
        riskPerTradePct: exec.riskPerTradePct ?? 0,
        feeBps: exec.feeBps ?? 0,
        slippageBps: exec.slippageBps ?? 0,
        fillModel: 'next-open',
      },
      ...(seed === undefined ? {} : { seed }),
      ...(label === '' ? {} : { label }),
    },
  };
}

export function randomSeed(random: () => number = Math.random): number {
  return Math.floor(random() * (SEED_MAX + 1));
}
