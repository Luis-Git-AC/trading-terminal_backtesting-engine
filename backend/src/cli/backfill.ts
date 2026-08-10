import { parseArgs } from 'node:util';
import { isTimeframe, type Timeframe } from '@tt/shared';
import { env } from '../config/env.js';
import { closePool, getPool } from '../db/pool.js';
import { createBitgetRestClient } from '../ingest/exchange/bitget/rest.js';
import { backfillSeries, type BackfillEvent, type BackfillReport } from '../ingest/backfill.js';

const USAGE = `
Uso: npm run backfill -- --symbol BTCUSDT --timeframe 15m [--from ISO] [--to ISO]
     npm run backfill -- --all [--from ISO] [--to ISO]

  --symbol     Par a rellenar. Obligatorio salvo con --all
  --timeframe  1m | 15m | 1h. Obligatorio salvo con --all
  --from       Inicio del historico en ISO 8601 UTC. Por defecto BACKFILL_FROM
  --to         Fin del historico en ISO 8601 UTC. Por defecto ahora
  --all        Recorre SYMBOLS x TIMEFRAMES del entorno
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

function formatMs(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function iso(ts: number): string {
  return new Date(ts).toISOString();
}

function onEvent(event: BackfillEvent): void {
  if (event.kind === 'start') {
    const mode = event.resumed ? 'reanudando desde' : 'empezando en';
    console.log(
      `\n${event.symbol} ${event.timeframe}: ${mode} ${iso(event.cursorTs)}, objetivo ${iso(event.targetTs)}`,
    );
    return;
  }

  if (event.kind === 'progress') {
    const eta = event.etaMs === null ? 'desconocida' : formatMs(event.etaMs);
    console.log(
      `  ${event.pages} paginas · ${event.fetched} velas · ${event.candlesPerSecond.toFixed(1)} velas/s · ` +
        `cursor ${iso(event.cursorTs)} · faltan ${event.remaining} · ETA ${eta}`,
    );
    return;
  }

  const { report } = event;
  const detail =
    report.pages === 0
      ? 'ya estaba al dia, nada que pedir'
      : `${report.upserted} velas escritas en ${report.pages} paginas, hasta ${iso(report.reachedTs)}`;
  console.log(`  ${detail} (${report.stoppedBy}) en ${formatMs(report.elapsedMs)}`);
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

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      symbol: { type: 'string' },
      timeframe: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      all: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(USAGE);
    return;
  }

  const from = parseInstant(values.from, '--from') ?? Date.parse(env.BACKFILL_FROM);
  const to = parseInstant(values.to, '--to');
  const series = seriesToRun(values);

  const feed = createBitgetRestClient({
    baseUrl: env.EXCHANGE_REST_URL,
    pageLimit: env.BACKFILL_PAGE_LIMIT,
    rps: env.BACKFILL_RPS,
    log: (event) => {
      if (event.kind === 'retry') {
        console.warn(`  reintento ${event.attempt} en ${event.delayMs} ms: ${event.reason}`);
        return;
      }
      console.warn(
        `  ${event.rows.length} vela(s) descartada(s) en ${event.symbol} ${event.timeframe}: ` +
          event.rows.map((row) => `[${row.index}] ${row.reason}`).join(', '),
      );
    },
  });

  const pool = getPool();
  const reports: BackfillReport[] = [];

  try {
    for (const { symbol, timeframe } of series) {
      reports.push(
        await backfillSeries({ pool, feed, symbol, timeframe, from, to, log: onEvent }),
      );
    }
  } finally {
    await closePool();
  }

  const written = reports.reduce((total, report) => total + report.upserted, 0);
  const pending = reports.filter((report) => !report.done);

  console.log(`\n${written} velas escritas en ${reports.length} serie(s).`);
  if (pending.length > 0) {
    console.log(
      `Sin terminar: ${pending.map((r) => `${r.symbol} ${r.timeframe} (${r.stoppedBy})`).join(', ')}`,
    );
    process.exitCode = 1;
  }
}

await main();
