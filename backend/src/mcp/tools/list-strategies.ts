import type { StrategyCatalog } from '@tt/shared';
import { buildCatalog } from '../../strategies/registry.js';

export function listStrategiesTool(): StrategyCatalog {
  return buildCatalog();
}
