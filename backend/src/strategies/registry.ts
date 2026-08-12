import type { StrategyCatalog, StrategyMeta, StrategyParam } from '@tt/shared';
import { z } from 'zod';
import type { StrategyDefinition } from '../engine/types.js';
import { emaCross } from './ema-cross.js';
import { rangeBreakout } from './range-breakout.js';

export class StrategyNotFoundError extends Error {
  override readonly name = 'StrategyNotFoundError';
  readonly code = 'NOT_FOUND' as const;
  readonly strategyId: string;

  constructor(strategyId: string, known: readonly string[]) {
    super(`Estrategia desconocida "${strategyId}". Disponibles: ${known.join(', ')}.`);
    this.strategyId = strategyId;
  }
}

export class UndescribableParamError extends Error {
  override readonly name = 'UndescribableParamError';
  readonly strategyId: string;
  readonly key: string;

  constructor(strategyId: string, key: string, detail: string) {
    super(`No se puede describir el parametro "${key}" de "${strategyId}": ${detail}.`);
    this.strategyId = strategyId;
    this.key = key;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyStrategy = StrategyDefinition<any, any>;

export const STRATEGIES: readonly AnyStrategy[] = [emaCross, rangeBreakout];

const BY_ID = new Map<string, AnyStrategy>(
  STRATEGIES.map((strategy) => [strategy.id, strategy]),
);

export function strategyIds(): readonly string[] {
  return STRATEGIES.map((strategy) => strategy.id);
}

export function getStrategy(id: string): AnyStrategy {
  const strategy = BY_ID.get(id);
  if (strategy === undefined) {
    throw new StrategyNotFoundError(id, strategyIds());
  }
  return strategy;
}

interface JsonSchemaProperty {
  readonly type?: string;
  readonly enum?: readonly unknown[];
  readonly default?: unknown;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly description?: string;
}

function describeParam(
  strategyId: string,
  key: string,
  property: JsonSchemaProperty,
): StrategyParam {
  const { type, enum: options, default: fallback, minimum, maximum, description } = property;

  if (fallback === undefined) {
    throw new UndescribableParamError(strategyId, key, 'no declara default');
  }

  const base = {
    key,
    ...(minimum === undefined ? {} : { min: minimum }),
    ...(maximum === undefined ? {} : { max: maximum }),
    ...(description === undefined ? {} : { label: description }),
  };

  if (options !== undefined) {
    if (typeof fallback !== 'string') {
      throw new UndescribableParamError(strategyId, key, 'el default del enum no es un string');
    }
    return {
      ...base,
      type: 'enum',
      default: fallback,
      options: options.filter((option): option is string => typeof option === 'string'),
    };
  }
  if (type === 'boolean') {
    return { ...base, type: 'bool', default: fallback === true };
  }
  if (type === 'integer') {
    return { ...base, type: 'int', default: Number(fallback) };
  }
  if (type === 'number') {
    return { ...base, type: 'float', default: Number(fallback) };
  }
  throw new UndescribableParamError(strategyId, key, `tipo no soportado "${String(type)}"`);
}

export function describeStrategy(strategy: AnyStrategy): StrategyMeta {
  const jsonSchema = z.toJSONSchema(strategy.paramsSchema, { io: 'input' });
  const properties = (jsonSchema as { properties?: Record<string, JsonSchemaProperty> })
    .properties;

  if (properties === undefined) {
    throw new UndescribableParamError(strategy.id, '<raiz>', 'el esquema no expone properties');
  }

  return {
    id: strategy.id,
    name: strategy.name,
    version: strategy.version,
    description: strategy.description,
    params: Object.entries(properties).map(([key, property]) =>
      describeParam(strategy.id, key, property),
    ),
  };
}

export function buildCatalog(): StrategyCatalog {
  return { strategies: STRATEGIES.map((strategy) => describeStrategy(strategy)) };
}
