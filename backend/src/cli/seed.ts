import { parseArgs } from 'node:util';
import { alignTs, isTimeframe, timeframeToMs, type Timeframe } from '@tt/shared';
import { env } from '../config/env.js';
import { closePool, getPool } from '../db/pool.js';
import { createCandlesRepository } from '../db/repositories/candles.repo.js';
import { DEFAULT_SEED_BARS, seedSeries, type SeedReport } from '../db/seed.js';

const USAGE = `
Uso: npm run db:seed -- --symbol BTCUSDT --timeframe 15m [--bars 2000] [--seed 1] [--from ISO]
     npm run db:seed -- --all [--bars 2000] [--seed 1] [--from ISO]

  --symbol     Par a generar. Obligatorio salvo con --all
  --timeframe  1m | 15m | 1h. Obligatorio salvo con --all
  --bars       Velas a generar por serie. Por defecto ${DEFAULT_SEED_BARS}
  --seed       Semilla del PRNG. Por defecto 1
  --from       Inicio de la serie en ISO 8601 UTC. Por defecto BACKFILL_FROM
  --all        Recorre SYMBOLS x TIMEFRAMES del entorno

Genera velas sinteticas (source = "synthetic") y no toca la red. Pensado para trabajar sin
conexion al exchange; para datos reales usa "npm run backfill".
`.trim();

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(1);
}

function parseInstant(raw: string | undefined, label: string): number | undefined {
  if (raw === undefined) return undefined;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) fail(`${label} no es una fecha ISO 8601 valida: ${raw}`);
  return ms;
}

function iso(ts: number): string {
  return new Date(ts).toISOString();
}

function seriesToRun(values: {
  all?: boolean | undefined;
  symbol?: string | undefined;
  timeframe?: string | undefined;
}): { symbol: string; timeframe: Timeframe }[] {
  if (values.all === true) {
    return env.SYMBOLS.flatMap((symbol) =>
      env.TIMEFRAMES.map((timeframe) => ({ symbol, timeframe })),
    );
  }

  if (values.symbol === undefined) fail('Falta --symbol (o usa --all).');
  if (values.timeframe === undefined) fail('Falta --timeframe (o usa --all).');
  if (!isTimeframe(values.timeframe)) {
    fail(`--timeframe invalido: ${values.timeframe}. Admitidos: 1m, 15m, 1h.`);
  }

  return [{ symbol: values.symbol, timeframe: values.timeframe }];
}

function onReport(report: SeedReport): void {
  if (report.generated === 0) {
    console.log(
      `${report.symbol} ${report.timeframe}: nada que generar (--from demasiado reciente para --bars ${report.requestedBars})`,
    );
    return;
  }

  const note = report.generated < report.requestedBars ? ` de ${report.requestedBars} pedidas` : '';
  const unchanged = report.generated - report.written;
  const skip = unchanged > 0 ? `, ${unchanged} ya coincidian` : '';

  console.log(
    `${report.symbol} ${report.timeframe}: ${report.generated} vela(s) sintetica(s)${note}, ` +
      `${report.written} escrita(s)${skip}, ${iso(report.fromTs)} -> ${iso(report.toTs)} (seed ${report.seed})`,
  );
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      symbol: { type: 'string' },
      timeframe: { type: 'string' },
      bars: { type: 'string' },
      seed: { type: 'string' },
      from: { type: 'string' },
      all: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(USAGE);
    return;
  }

  const bars = values.bars === undefined ? DEFAULT_SEED_BARS : Number.parseInt(values.bars, 10);
  if (!Number.isInteger(bars) || bars <= 0) {
    fail(`--bars invalido: ${values.bars}. Debe ser un entero positivo.`);
  }

  const seed = values.seed === undefined ? 1 : Number.parseInt(values.seed, 10);
  if (!Number.isInteger(seed)) {
    fail(`--seed invalido: ${values.seed}. Debe ser un entero.`);
  }

  const from = parseInstant(values.from, '--from') ?? Date.parse(env.BACKFILL_FROM);
  const series = seriesToRun(values);

  const pool = getPool();
  const candles = createCandlesRepository(pool);
  const reports: SeedReport[] = [];

  try {
    for (const { symbol, timeframe } of series) {
      const report = await seedSeries({
        candles,
        symbol,
        timeframe,
        from: alignTs(from, timeframe),
        bars,
        seed,
        closedBoundary: alignTs(Date.now(), timeframe) - timeframeToMs(timeframe),
      });
      reports.push(report);
      onReport(report);
    }
  } finally {
    await closePool();
  }

  const written = reports.reduce((total, report) => total + report.written, 0);
  console.log(`\n${written} vela(s) sintetica(s) escritas en ${reports.length} serie(s).`);
}

await main();
