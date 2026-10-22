import { describe, expect, it } from 'vitest';
import type { RunnableSource } from './adapter.js';
import { buildSourceRegistry } from './registry.js';

function source(id: string, requiredEnv: readonly string[] = []): RunnableSource {
  return {
    id,
    schedule: '*/5 * * * *',
    requiredEnv,
    run: () =>
      Promise.resolve({
        sourceId: id,
        items: 0,
        discarded: 0,
        written: 0,
        skipped: 0,
        durationMs: 0,
      }),
  };
}

describe('buildSourceRegistry', () => {
  it('activa las fuentes sin claves requeridas', () => {
    const registry = buildSourceRegistry({ candidates: [source('libre')], env: {} });

    expect(registry.enabled.map((item) => item.id)).toEqual(['libre']);
    expect(registry.disabled).toEqual([]);
    expect(registry.get('libre')?.id).toBe('libre');
  });

  it('desactiva la fuente a la que le falta una clave y dice cual', () => {
    const registry = buildSourceRegistry({
      candidates: [source('fred', ['FRED_API_KEY'])],
      env: {},
    });

    expect(registry.enabled).toEqual([]);
    expect(registry.disabled).toEqual([
      { source: expect.objectContaining({ id: 'fred' }), missingEnv: ['FRED_API_KEY'] },
    ]);
    expect(registry.get('fred')).toBeUndefined();
  });

  it('una clave vacia cuenta como ausente', () => {
    const registry = buildSourceRegistry({
      candidates: [source('eia', ['EIA_API_KEY'])],
      env: { EIA_API_KEY: '' },
    });

    expect(registry.disabled[0]?.missingEnv).toEqual(['EIA_API_KEY']);
  });

  it('con varias claves lista todas las que faltan y solo esas', () => {
    const registry = buildSourceRegistry({
      candidates: [source('doble', ['UNA', 'OTRA', 'TERCERA'])],
      env: { OTRA: 'presente' },
    });

    expect(registry.disabled[0]?.missingEnv).toEqual(['UNA', 'TERCERA']);
  });

  it('una fuente desactivada no impide que las demas se activen', () => {
    const registry = buildSourceRegistry({
      candidates: [source('sin', ['FALTA']), source('con'), source('otra')],
      env: {},
    });

    expect(registry.enabled.map((item) => item.id)).toEqual(['con', 'otra']);
    expect(registry.disabled.map((item) => item.source.id)).toEqual(['sin']);
  });
});
