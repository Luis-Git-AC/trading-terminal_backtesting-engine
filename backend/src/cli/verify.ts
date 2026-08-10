import { parseArgs } from 'node:util';
import { isTimeframe, timeframeToMs, type Timeframe } from '@tt/shared';
import { env } from '../config/env.js';
import { closePool, getPool } from '../db/pool.js';
import { createCandlesRepository } from '../db/repositories/candles.repo.js';
import { verifyIntegrity, type IntegrityReport } from '../ingest/integrity.js';

const USAGE = `
Uso: npm run verify -- --symbol BTCUSDT --timeframe 15m [--from ISO] [--to ISO]
     npm run verify -- --all [--from ISO] [--to ISO]

  --symbol     Par a verificar. Obligatorio salvo con --all
  --timeframe  1m | 15m | 1h. Obligatorio salvo con --all
  --from       Inicio del rango en ISO 8601 UTC. Por defecto, la vela mas antigua guardada
  --to         Fin del rango en ISO 8601 UTC (exclusivo). Por defecto, la mas reciente + 1 vela
  --all        Recorre SYMBOLS x TIMEFRAMES del entorno

Sale con codigo 1 si hay violaciones de integridad. Los huecos se informan pero no fallan:
pueden ser legitimos del exchange.
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

function seriesToVerify(values: {
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

function print(report: IntegrityReport): void {
  const { symbol, timeframe } = report;
  console.log(`\n${symbol} ${timeframe}  ${iso(report.from)} -> ${iso(report.to)}`);

  if (report.actual === 0) {
    console.log('  sin velas en el rango');
    return;
  }

  console.log(
    `  ${report.actual} velas de ${report.expected} esperadas` +
      (report.missing > 0 ? ` (faltan ${report.missing})` : ' (completo)'),
  );
  console.log(`  primera ${iso(report.firstTs ?? report.from)} · ultima ${iso(report.lastTs ?? report.to)}`);

  if (report.gaps.length === 0) {
    console.log('  huecos: ninguno');
  } else {
    console.log(`  huecos: ${report.gaps.length}`);
    for (const gap of report.gaps.slice(0, 20)) {
      console.log(`    ${iso(gap.fromTs)} -> ${iso(gap.toTs)} (${gap.missing} velas)`);
    }
    if (report.gaps.length > 20) console.log(`    ... y ${report.gaps.length - 20} mas`);
  }

  if (report.ok) {
    console.log('  integridad: OK (alineacion, duplicados, orden, OHLC, volumen, futuro)');
    return;
  }

  console.log(`  integridad: ${report.totalViolations} violacion(es)`);
  for (const [kind, count] of Object.entries(report.violationCounts)) {
    if (count > 0) console.log(`    ${kind}: ${count}`);
  }
  for (const violation of report.violations) {
    console.log(`    [${violation.kind}] ${iso(violation.ts)} — ${violation.detail}`);
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      symbol: { type: 'string' },
      timeframe: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      all: { type: 'boolean', default: false },
    },
    strict: true,
  });

  const fromArg = parseInstant(values.from, '--from');
  const toArg = parseInstant(values.to, '--to');
  const series = seriesToVerify(values);

  const pool = getPool();
  const candles = createCandlesRepository(pool);
  const reports: IntegrityReport[] = [];

  try {
    for (const { symbol, timeframe } of series) {
      const coverage = await candles.getCoverage({ symbol, timeframe });
      const from = fromArg ?? coverage.fromTs;
      const to = toArg ?? (coverage.toTs === null ? null : coverage.toTs + timeframeToMs(timeframe));

      if (from === null || to === null) {
        console.log(`\n${symbol} ${timeframe}: no hay velas guardadas, nada que verificar`);
        continue;
      }

      reports.push(await verifyIntegrity({ db: pool, symbol, timeframe, from, to }));
    }
  } finally {
    await closePool();
  }

  for (const report of reports) print(report);

  const broken = reports.filter((report) => !report.ok);
  const gaps = reports.reduce((total, report) => total + report.gaps.length, 0);

  console.log(
    `\n${reports.length} serie(s) verificada(s), ${broken.length} con violaciones, ${gaps} hueco(s).`,
  );

  if (broken.length > 0) process.exitCode = 1;
}

await main();
