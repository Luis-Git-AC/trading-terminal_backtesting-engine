import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, seriesLogger, type AppLogger } from './logger.js';

interface Capture {
  logger: AppLogger;
  lines: (this: void) => string[];
  records: (this: void) => Record<string, unknown>[];
}

function capture(options: { level?: string } = {}): Capture {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString('utf8'));
      callback();
    },
  });

  const logger = createLogger({
    role: 'ingestor',
    level: options.level ?? 'info',
    destination,
  });

  const lines = (): string[] =>
    chunks
      .join('')
      .split('\n')
      .filter((line) => line.length > 0);

  return {
    logger,
    lines,
    records: () => lines().map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe('createLogger', () => {
  it('emite JSON parseable, una linea por evento', () => {
    const { logger, lines, records } = capture();

    logger.info('arrancando');
    logger.info({ paso: 2 }, 'segundo evento');

    expect(lines()).toHaveLength(2);
    for (const line of lines()) {
      expect(() => JSON.parse(line) as unknown).not.toThrow();
    }
    expect(records()[1]).toMatchObject({ paso: 2, msg: 'segundo evento' });
  });

  it('incluye role en todas las lineas', () => {
    const { logger, records } = capture();

    logger.info('una');
    logger.warn('otra');
    logger.error('y otra');

    expect(records()).toHaveLength(3);
    expect(records().every((record) => record.role === 'ingestor')).toBe(true);
  });

  it('escribe el nivel como etiqueta y la hora en ISO', () => {
    const { logger, records } = capture();

    logger.warn('cuidado');

    const record = records()[0];
    expect(record?.level).toBe('warn');
    expect(typeof record?.time).toBe('string');
    expect(() => new Date(String(record?.time)).toISOString()).not.toThrow();
  });

  it('el hijo de serie anade symbol y timeframe sin perder role', () => {
    const { logger, records } = capture();

    seriesLogger(logger, 'BTCUSDT', '1m').info({ written: 3 }, 'velas persistidas');

    expect(records()[0]).toMatchObject({
      role: 'ingestor',
      symbol: 'BTCUSDT',
      timeframe: '1m',
      written: 3,
      msg: 'velas persistidas',
    });
  });

  it('serializa los errores sin volcar el objeto crudo', () => {
    const { logger, records } = capture();

    logger.error({ err: new Error('conexion caida') }, 'fallo');

    const err = records()[0]?.err;
    expect(err).toMatchObject({ type: 'Error', message: 'conexion caida' });
    expect(typeof (err as { stack?: unknown }).stack).toBe('string');
  });

  it('respeta el nivel configurado', () => {
    const { logger, records } = capture({ level: 'warn' });

    logger.debug('no deberia salir');
    logger.info('tampoco');
    logger.warn('esta si');

    expect(records()).toHaveLength(1);
    expect(records()[0]?.msg).toBe('esta si');
  });
});
