import { strategyCatalogSchema } from '@tt/shared';
import { describe, expect, it } from 'vitest';
import { emaCross, emaCrossParamsSchema } from './ema-cross.js';
import { rangeBreakout, rangeBreakoutParamsSchema } from './range-breakout.js';
import {
  STRATEGIES,
  StrategyNotFoundError,
  buildCatalog,
  describeStrategy,
  getStrategy,
  strategyIds,
} from './registry.js';

describe('getStrategy', () => {
  it('devuelve las estrategias registradas', () => {
    expect(getStrategy('ema-cross')).toBe(emaCross);
    expect(getStrategy('range-breakout')).toBe(rangeBreakout);
  });

  it('lanza NOT_FOUND tipado si no existe', () => {
    expect(() => getStrategy('no-existe')).toThrow(StrategyNotFoundError);
    try {
      getStrategy('no-existe');
    } catch (error) {
      expect(error instanceof StrategyNotFoundError ? error.code : null).toBe('NOT_FOUND');
    }
  });

  it('el mensaje enumera las disponibles', () => {
    expect(() => getStrategy('no-existe')).toThrow(/ema-cross/);
  });

  it('el registro es explicito y su orden es estable', () => {
    expect(strategyIds()).toEqual(['ema-cross', 'range-breakout']);
    expect(strategyIds()).toEqual(STRATEGIES.map((strategy) => strategy.id));
  });
});

describe('describeStrategy', () => {
  it('deriva los metadatos de ema-cross del esquema Zod', () => {
    const meta = describeStrategy(emaCross);
    expect(meta.id).toBe('ema-cross');
    expect(meta.name).toBe('EMA Cross');
    expect(meta.version).toBe('1.0.0');
    expect(meta.params.map((param) => param.key)).toEqual([
      'fastPeriod',
      'slowPeriod',
      'atrPeriod',
      'atrStopMult',
      'takeProfitR',
      'allowShort',
    ]);
  });

  it('reproduce la tabla de docs/03 para fastPeriod y allowShort', () => {
    const meta = describeStrategy(emaCross);
    const fast = meta.params.find((param) => param.key === 'fastPeriod');
    expect(fast).toEqual({
      key: 'fastPeriod',
      type: 'int',
      default: 12,
      min: 2,
      max: 200,
      label: 'EMA rapida',
    });

    const allowShort = meta.params.find((param) => param.key === 'allowShort');
    expect(allowShort).toEqual({
      key: 'allowShort',
      type: 'bool',
      default: true,
      label: 'Permitir cortos',
    });
  });

  it('distingue int de float', () => {
    const meta = describeStrategy(emaCross);
    expect(meta.params.find((param) => param.key === 'atrPeriod')?.type).toBe('int');
    expect(meta.params.find((param) => param.key === 'atrStopMult')?.type).toBe('float');
  });

  it('describe el enum de stopMode con sus opciones', () => {
    const meta = describeStrategy(rangeBreakout);
    expect(meta.params.find((param) => param.key === 'stopMode')).toEqual({
      key: 'stopMode',
      type: 'enum',
      default: 'nearest',
      options: ['range', 'atr', 'nearest'],
      label: 'Modo de stop',
    });
  });

  it('los defaults del catalogo son exactamente los del paramsSchema', () => {
    const cases = [
      { meta: describeStrategy(emaCross), parsed: emaCrossParamsSchema.parse({}) },
      { meta: describeStrategy(rangeBreakout), parsed: rangeBreakoutParamsSchema.parse({}) },
    ];
    for (const { meta, parsed } of cases) {
      const fromCatalog = Object.fromEntries(
        meta.params.map((param) => [param.key, param.default]),
      );
      expect(fromCatalog).toEqual(parsed);
    }
  });
});

describe('buildCatalog', () => {
  it('valida contra el esquema del contrato de API', () => {
    expect(() => strategyCatalogSchema.parse(buildCatalog())).not.toThrow();
  });

  it('incluye todas las estrategias del registro', () => {
    const catalog = buildCatalog();
    expect(catalog.strategies.map((strategy) => strategy.id)).toEqual(strategyIds());
  });

  it('es determinista entre llamadas', () => {
    expect(buildCatalog()).toEqual(buildCatalog());
  });

  it('todo parametro lleva key, type y default', () => {
    for (const strategy of buildCatalog().strategies) {
      expect(strategy.params.length).toBeGreaterThan(0);
      for (const param of strategy.params) {
        expect(param.key).not.toBe('');
        expect(['int', 'float', 'bool', 'enum']).toContain(param.type);
        expect(param.default).toBeDefined();
      }
    }
  });
});
