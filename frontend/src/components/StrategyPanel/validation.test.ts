import { describe, expect, it } from 'vitest';
import { SEED_MAX, type CoverageResponse, type StrategyMeta } from '@tt/shared';
import {
  EXEC_DEFAULTS,
  dayEndMs,
  dayStartMs,
  defaultParams,
  isoDay,
  randomSeed,
  validateForm,
  validateParam,
  type FormState,
} from '@/components/StrategyPanel/validation';

const STRATEGY: StrategyMeta = {
  id: 'ema-cross',
  name: 'EMA Cross',
  version: '1.0.0',
  description: 'Cruce de EMA',
  params: [
    { key: 'fastPeriod', type: 'int', default: 12, min: 2, max: 200, label: 'EMA rapida' },
    { key: 'atrStopMult', type: 'float', default: 2, min: 0.1, max: 10 },
    { key: 'allowShort', type: 'bool', default: true },
    { key: 'stopMode', type: 'enum', default: 'nearest', options: ['range', 'atr', 'nearest'] },
  ],
};

const COVERAGE: CoverageResponse = {
  symbol: 'BTCUSDT',
  timeframe: '15m',
  from: '2026-01-01T00:00:00.000Z',
  to: '2026-06-30T23:45:00.000Z',
  candles: 17_472,
  expected: 17_472,
  missing: 0,
  gaps: [],
  backfill: { done: true, cursor: null },
};

function form(overrides: Partial<FormState> = {}): FormState {
  return {
    strategyId: 'ema-cross',
    params: defaultParams(STRATEGY),
    exec: EXEC_DEFAULTS,
    seed: '',
    from: '2026-02-01',
    to: '2026-03-01',
    label: '',
    ...overrides,
  };
}

function validate(overrides: Partial<FormState> = {}, coverage = COVERAGE) {
  return validateForm(form(overrides), STRATEGY, coverage, 'BTCUSDT', '15m');
}

describe('defaultParams', () => {
  it('toma los valores por defecto que declara el catalogo', () => {
    expect(defaultParams(STRATEGY)).toEqual({
      fastPeriod: 12,
      atrStopMult: 2,
      allowShort: true,
      stopMode: 'nearest',
    });
  });
});

describe('validateParam', () => {
  it('acepta un entero dentro de rango', () => {
    expect(validateParam(STRATEGY.params[0]!, 12)).toBeNull();
    expect(validateParam(STRATEGY.params[0]!, '30')).toBeNull();
  });

  it('rechaza por debajo del minimo y por encima del maximo', () => {
    expect(validateParam(STRATEGY.params[0]!, 1)).toContain('menor que 2');
    expect(validateParam(STRATEGY.params[0]!, 201)).toContain('mayor que 200');
  });

  it('rechaza un decimal donde el catalogo pide entero', () => {
    expect(validateParam(STRATEGY.params[0]!, 12.5)).toBe('Debe ser un entero');
  });

  it('acepta decimales en un float', () => {
    expect(validateParam(STRATEGY.params[1]!, 2.5)).toBeNull();
    expect(validateParam(STRATEGY.params[1]!, 0.05)).toContain('menor que 0.1');
  });

  it('rechaza texto que no es numero', () => {
    expect(validateParam(STRATEGY.params[0]!, 'doce')).toBe('Hace falta un numero');
    expect(validateParam(STRATEGY.params[0]!, '')).toBe('Hace falta un numero');
  });

  it('el enum solo admite las opciones del catalogo', () => {
    expect(validateParam(STRATEGY.params[3]!, 'atr')).toBeNull();
    expect(validateParam(STRATEGY.params[3]!, 'otro')).toContain('range, atr, nearest');
  });

  it('el bool solo admite booleanos', () => {
    expect(validateParam(STRATEGY.params[2]!, false)).toBeNull();
    expect(validateParam(STRATEGY.params[2]!, 'si')).toBe('Debe ser verdadero o falso');
  });
});

describe('validateForm', () => {
  it('con los defaults construye un cuerpo valido para el API', () => {
    const result = validate();

    expect(result.errors).toEqual({});
    expect(result.body).toEqual({
      symbol: 'BTCUSDT',
      timeframe: '15m',
      from: dayStartMs('2026-02-01'),
      to: dayEndMs('2026-03-01'),
      strategyId: 'ema-cross',
      params: { fastPeriod: 12, atrStopMult: 2, allowShort: true, stopMode: 'nearest' },
      exec: {
        initialCapital: 10_000,
        riskPerTradePct: 1,
        feeBps: 6,
        slippageBps: 2,
        fillModel: 'next-open',
      },
    });
  });

  it('un parametro fuera de rango deja el cuerpo a null y marca el campo', () => {
    const result = validate({ params: { ...defaultParams(STRATEGY), fastPeriod: '999' } });

    expect(result.body).toBeNull();
    expect(result.errors['params.fastPeriod']).toContain('mayor que 200');
  });

  it('un valor de ejecucion fuera de rango bloquea el envio', () => {
    const result = validate({ exec: { ...EXEC_DEFAULTS, riskPerTradePct: '0' } });

    expect(result.body).toBeNull();
    expect(result.errors['exec.riskPerTradePct']).toContain('mayor que 0');
  });

  it('el fee admite 0 pero no negativos', () => {
    expect(validate({ exec: { ...EXEC_DEFAULTS, feeBps: '0' } }).body).not.toBeNull();
    expect(validate({ exec: { ...EXEC_DEFAULTS, feeBps: '-1' } }).errors['exec.feeBps']).toContain(
      'menor que 0',
    );
  });

  it('la semilla viaja tal cual cuando se escribe', () => {
    expect(validate({ seed: '42' }).body?.seed).toBe(42);
  });

  it('sin semilla no se manda el campo, para que lo genere el servidor', () => {
    expect(validate().body).not.toHaveProperty('seed');
  });

  it('rechaza semillas no enteras o por encima del maximo', () => {
    expect(validate({ seed: '4.5' }).errors.seed).toContain('entero');
    expect(validate({ seed: String(SEED_MAX + 1) }).errors.seed).toContain(String(SEED_MAX));
  });

  it('un rango fuera de la cobertura se bloquea nombrando la disponible', () => {
    const result = validate({ from: '2025-01-01', to: '2025-02-01' });

    expect(result.body).toBeNull();
    expect(result.errors.range).toContain('2026-01-01');
    expect(result.errors.range).toContain('2026-06-30');
  });

  it('la fecha final debe ser posterior a la inicial', () => {
    expect(validate({ from: '2026-03-01', to: '2026-02-01' }).errors.range).toContain('posterior');
  });

  it('sin ninguna vela guardada explica que hay que hacer', () => {
    const empty: CoverageResponse = { ...COVERAGE, from: null, to: null, candles: 0 };

    expect(validate({}, empty).errors.range).toContain('backfill');
  });

  it('un hueco dentro del rango avisa pero no bloquea', () => {
    const withGap: CoverageResponse = {
      ...COVERAGE,
      gaps: [{ from: '2026-02-10T00:00:00.000Z', to: '2026-02-10T01:00:00.000Z', filled: false }],
    };

    const result = validate({}, withGap);

    expect(result.body).not.toBeNull();
    expect(result.warnings[0]).toContain('hueco');
  });

  it('un hueco fuera del rango no avisa', () => {
    const withGap: CoverageResponse = {
      ...COVERAGE,
      gaps: [{ from: '2026-05-10T00:00:00.000Z', to: '2026-05-10T01:00:00.000Z', filled: false }],
    };

    expect(validate({}, withGap).warnings).toEqual([]);
  });

  it('una etiqueta demasiado larga se rechaza', () => {
    expect(validate({ label: 'x'.repeat(121) }).errors.label).toContain('120');
  });

  it('sin estrategia no hay cuerpo', () => {
    expect(validateForm(form(), undefined, COVERAGE, 'BTCUSDT', '15m').body).toBeNull();
  });
});

describe('isoDay', () => {
  it('recorta el dia de una fecha ISO y tolera null', () => {
    expect(isoDay('2026-01-01T00:00:00.000Z')).toBe('2026-01-01');
    expect(isoDay(null)).toBe('');
  });
});

describe('randomSeed', () => {
  it('se queda dentro del rango que admite el contrato', () => {
    expect(randomSeed(() => 0)).toBe(0);
    expect(randomSeed(() => 0.9999999)).toBeLessThanOrEqual(SEED_MAX);
    expect(randomSeed(() => 0.5)).toBeGreaterThan(0);
  });
});
