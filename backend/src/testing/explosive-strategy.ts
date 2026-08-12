import type { StrategyDefinition } from '../engine/types.js';
import { emaCross, type EmaCrossParams } from '../strategies/ema-cross.js';

export function explosiveStrategy(message: string): StrategyDefinition<EmaCrossParams, null> {
  return {
    id: 'ema-cross',
    name: 'estrategia que revienta',
    version: '1.0.0',
    description: 'estrategia de test que lanza una excepcion en la primera barra',
    paramsSchema: emaCross.paramsSchema,
    warmupBars: () => 0,
    init: () => null,
    onBar: () => {
      throw new Error(message);
    },
  };
}
