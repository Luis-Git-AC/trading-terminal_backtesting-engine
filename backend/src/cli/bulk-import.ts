import { Buffer } from 'node:buffer';
import { parseArgs } from 'node:util';
import { isTimeframe, timeframeToMs, type Timeframe } from '@tt/shared';
import { closePool, getPool } from '../db/pool.js';
import { createCandlesRepository, type CandlesRepository } from '../db/repositories/candles.repo.js';
import {
  BulkImportError,
  dailyFiles,
  isCurrentMonth,
  loadBulkFile,
  monthKeys,
  monthlyFiles,
  type BulkFile,
  type BytesFetcher,
} from '../ingest/exchange/binance/bulk.js';

const EXCHANGE = 'binance';

const USAGE = `
Uso: npm run bulk:binance -- --symbol BTCUSDT --timeframe 1h --from 2024-01 --to 2024-03

  --symbol     Par a importar (obligatorio)
  --timeframe  1m | 15m | 1h (obligatorio)
  --from       Primer mes en YYYY-MM (obligatorio)
  --to         Ultimo mes en YYYY-MM (obligatorio)
  --force      Reimporta los meses que ya estan completos

Del mes en curso no hay mensual en data.binance.vision: se baja por dias hasta
ayer, y lo de hoy lo completa "npm run backfill -- --exchange binance ...".
`.trim();

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(1);
}

/** El rango que cubre un fichero: `YYYY-MM` es un mes y `YYYY-MM-DD` un dia. */
function fileRange(key: string): { from: number; to: number } {
  const [year, index, day] = key.split('-').map(Number);
  if (year === undefined || index === undefined) fail(`clave invalida: ${key}`);
  if (day === undefined) {
    return { from: Date.UTC(year, index - 1, 1), to: Date.UTC(year, index, 1) };
  }
  return { from: Date.UTC(year, index - 1, day), to: Date.UTC(year, index - 1, day + 1) };
}

async function isComplete(
  candles: CandlesRepository,
  symbol: string,
  timeframe: Timeframe,
  key: string,
): Promise<boolean> {
  const { from, to } = fileRange(key);
  const step = timeframeToMs(timeframe);
  const series = { exchange: EXCHANGE, symbol, timeframe };

  const first = await candles.getCandles({ ...series, from, to: from + step, limit: 1 });
  if (first.length === 0) return false;

  const last = await candles.getCandles({ ...series, from: to - step, to, limit: 1 });
  if (last.length === 0) return false;

  const gaps = await candles.findGaps({ ...series, from, to });
  return gaps.length === 0;
}

const fetchBytes: BytesFetcher = async (url) => {
  const response = await globalThis.fetch(url);
  if (response.status >= 400) return { status: response.status, bytes: new Uint8Array() };
  return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()) };
};

async function importFile(
  file: BulkFile,
  candles: CandlesRepository,
  symbol: string,
  timeframe: Timeframe,
): Promise<number> {
  const result = await loadBulkFile(file, fetchBytes, timeframe);

  if (result.discarded.length > 0) {
    console.log(
      `  ${result.discarded.length} filas descartadas: ` +
        `${result.discarded
          .slice(0, 3)
          .map((row) => `#${row.index} ${row.reason}`)
          .join(', ')}`,
    );
  }

  return candles.upsertCandles({
    exchange: EXCHANGE,
    symbol,
    timeframe,
    source: 'rest',
    candles: result.candles,
  });
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      symbol: { type: 'string' },
      timeframe: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      force: { type: 'boolean', default: false },
    },
  });

  const symbol = values.symbol?.toUpperCase();
  const timeframe = values.timeframe;
  const from = values.from;
  const to = values.to;

  if (symbol === undefined || symbol.length === 0) fail('Falta --symbol.');
  if (timeframe === undefined || !isTimeframe(timeframe)) {
    fail(`--timeframe invalido: ${String(timeframe)}. Validos: 1m, 15m, 1h.`);
  }
  if (from === undefined || to === undefined) fail('Faltan --from y --to (YYYY-MM).');

  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

  let files: BulkFile[];
  try {
    files = monthKeys(from, to).flatMap((month) =>
      isCurrentMonth(month, today)
        ? dailyFiles(symbol, timeframe, month, today)
        : monthlyFiles(symbol, timeframe, month, month),
    );
  } catch (error) {
    fail(error instanceof BulkImportError ? error.message : String(error));
  }

  const candles = createCandlesRepository(getPool());
  const startedAt = Date.now();
  let written = 0;
  let skipped = 0;
  const failed: string[] = [];

  console.log(`${symbol} ${timeframe}: ${files.length} fichero(s) desde data.binance.vision`);

  for (const file of files) {
    if (!values.force && (await isComplete(candles, symbol, timeframe, file.key))) {
      skipped += 1;
      console.log(`${file.key}: ya completo, se salta`);
      continue;
    }

    try {
      const upserted = await importFile(file, candles, symbol, timeframe);
      written += upserted;
      console.log(`${file.key}: ${upserted} velas escritas`);
    } catch (error) {
      // Un checksum que no cuadra o un mes que no existe no detienen el resto.
      failed.push(file.key);
      console.error(`${file.key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const seconds = Math.round((Date.now() - startedAt) / 1000);
  console.log(
    `\nHecho en ${seconds}s: ${written} velas escritas, ${skipped} fichero(s) ya completos` +
      (failed.length > 0 ? `, ${failed.length} con fallo (${failed.join(', ')})` : ''),
  );

  if (failed.length > 0) process.exitCode = 1;
}

try {
  await main();
} finally {
  await closePool();
}
