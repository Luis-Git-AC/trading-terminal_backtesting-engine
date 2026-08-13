import { startModeSchema, type StartMode } from './env.schema.js';

export class InvalidStartModeError extends Error {
  override readonly name = 'InvalidStartModeError';
  readonly value: string;

  constructor(value: string) {
    super(
      `Rol de arranque invalido: "${value}". Los validos son ${startModeSchema.options.join(', ')}.`,
    );
    this.value = value;
  }
}

export function resolveStartMode(argv: readonly string[], fallback: StartMode): StartMode {
  const raw = argv[2];

  if (raw === undefined || raw === '') {
    return fallback;
  }

  const parsed = startModeSchema.safeParse(raw);

  if (!parsed.success) {
    throw new InvalidStartModeError(raw);
  }

  return parsed.data;
}
