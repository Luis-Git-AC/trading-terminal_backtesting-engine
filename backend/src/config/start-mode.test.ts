import { describe, expect, it } from 'vitest';
import { InvalidStartModeError, resolveStartMode } from './start-mode.js';

function argv(...args: string[]): string[] {
  return ['node', 'main.ts', ...args];
}

describe('resolveStartMode', () => {
  it('sin argumento se queda con START_MODE', () => {
    expect(resolveStartMode(argv(), 'worker')).toBe('worker');
  });

  it('un argumento vacio tambien cae al fallback', () => {
    expect(resolveStartMode(argv(''), 'ingestor')).toBe('ingestor');
  });

  it('el argumento gana sobre START_MODE', () => {
    expect(resolveStartMode(argv('worker'), 'api')).toBe('worker');
    expect(resolveStartMode(argv('ingestor'), 'api')).toBe('ingestor');
    expect(resolveStartMode(argv('api'), 'worker')).toBe('api');
  });

  it('ignora los argumentos posteriores al rol', () => {
    expect(resolveStartMode(argv('worker', '--algo'), 'api')).toBe('worker');
  });

  it('un rol desconocido falla nombrando los validos', () => {
    expect(() => resolveStartMode(argv('cron'), 'api')).toThrow(InvalidStartModeError);
    expect(() => resolveStartMode(argv('cron'), 'api')).toThrow(/api, worker, ingestor/);
  });

  it('no acepta un rol con otra caja', () => {
    expect(() => resolveStartMode(argv('API'), 'worker')).toThrow(InvalidStartModeError);
  });
});
