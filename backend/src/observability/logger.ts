import {
  pino,
  stdSerializers,
  stdTimeFunctions,
  type DestinationStream,
  type Logger,
  type LoggerOptions,
} from 'pino';

export type AppRole = 'api' | 'worker' | 'ingestor';

export type AppLogger = Logger;

export interface CreateLoggerOptions {
  role: AppRole;
  level?: string;
  name?: string;
  base?: Record<string, unknown>;
  destination?: DestinationStream;
}

export function createLogger(options: CreateLoggerOptions): AppLogger {
  const config: LoggerOptions = {
    level: options.level ?? 'info',
    base: { role: options.role, ...options.base },
    formatters: {
      level: (label) => ({ level: label }),
    },
    timestamp: stdTimeFunctions.isoTime,
    serializers: {
      err: stdSerializers.err,
      error: stdSerializers.err,
    },
  };

  if (options.name !== undefined) config.name = options.name;

  return options.destination === undefined ? pino(config) : pino(config, options.destination);
}

export function seriesLogger(logger: AppLogger, symbol: string, timeframe: string): AppLogger {
  return logger.child({ symbol, timeframe });
}
