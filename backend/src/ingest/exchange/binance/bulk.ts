import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { Buffer } from 'node:buffer';
import type { IngestCandle, Timeframe } from '@tt/shared';
import type { DiscardedRow, NormalizeResult } from '../adapter.js';
import { normalizeCandles } from './normalize.js';
import { toInterval } from './types.js';

export const BULK_BASE_URL = 'https://data.binance.vision';

/** Tope del CSV descomprimido: un mes de 1m son ~43.200 filas de ~120 B. */
export const MAX_UNZIPPED_BYTES = 256 * 1024 * 1024;
export const MAX_COMPRESSION_RATIO = 200;

const EOCD_SIGNATURE = 0x06054b50;
const CD_SIGNATURE = 0x02014b50;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

export class BulkImportError extends Error {
  override readonly name = 'BulkImportError';
}

export function monthKeys(from: string, to: string): string[] {
  const start = parseMonth(from);
  const end = parseMonth(to);
  if (end < start) {
    throw new BulkImportError(`el mes final (${to}) es anterior al inicial (${from})`);
  }

  const keys: string[] = [];
  for (let month = start; month <= end; month += 1) {
    const year = Math.floor(month / 12);
    const index = month % 12;
    keys.push(`${String(year).padStart(4, '0')}-${String(index + 1).padStart(2, '0')}`);
  }
  return keys;
}

function parseMonth(raw: string): number {
  const match = /^(\d{4})-(\d{2})$/.exec(raw);
  const year = match?.[1];
  const month = match?.[2];
  if (year === undefined || month === undefined) {
    throw new BulkImportError(`el mes debe venir como YYYY-MM, recibido: ${raw}`);
  }
  const index = Number(month);
  if (index < 1 || index > 12) {
    throw new BulkImportError(`mes fuera de rango: ${raw}`);
  }
  return Number(year) * 12 + (index - 1);
}

export function monthlyName(symbol: string, timeframe: Timeframe, month: string): string {
  return `${symbol}-${toInterval(timeframe)}-${month}.zip`;
}

export function monthlyUrl(symbol: string, timeframe: Timeframe, month: string): string {
  const name = monthlyName(symbol, timeframe, month);
  return `${BULK_BASE_URL}/data/futures/um/monthly/klines/${symbol}/${toInterval(timeframe)}/${name}`;
}

export function dailyName(symbol: string, timeframe: Timeframe, day: string): string {
  return `${symbol}-${toInterval(timeframe)}-${day}.zip`;
}

export function dailyUrl(symbol: string, timeframe: Timeframe, day: string): string {
  const name = dailyName(symbol, timeframe, day);
  return `${BULK_BASE_URL}/data/futures/um/daily/klines/${symbol}/${toInterval(timeframe)}/${name}`;
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** El `.CHECKSUM` de Binance es `<sha256>  <nombre del zip>`. */
export function assertChecksum(bytes: Uint8Array, checksum: string, name: string): void {
  const expected = checksum.trim().split(/\s+/)[0]?.toLowerCase();
  if (expected === undefined || !/^[0-9a-f]{64}$/.test(expected)) {
    throw new BulkImportError(`el .CHECKSUM de ${name} no trae un sha256 legible: ${checksum.trim()}`);
  }

  const actual = sha256(bytes);
  if (actual !== expected) {
    throw new BulkImportError(
      `el sha256 de ${name} no cuadra con su .CHECKSUM (esperado ${expected}, calculado ${actual})`,
    );
  }
}

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

function readEntry(zip: Buffer): ZipEntry {
  const eocd = findEocd(zip);
  const entries = zip.readUInt16LE(eocd + 10);
  if (entries !== 1) {
    throw new BulkImportError(`el zip trae ${entries} entradas y solo se admite una`);
  }

  const cdOffset = zip.readUInt32LE(eocd + 16);
  if (cdOffset + 46 > zip.length || zip.readUInt32LE(cdOffset) !== CD_SIGNATURE) {
    throw new BulkImportError('el zip no tiene un directorio central legible');
  }

  const nameLength = zip.readUInt16LE(cdOffset + 28);
  const name = zip.toString('utf8', cdOffset + 46, cdOffset + 46 + nameLength);

  return {
    name,
    method: zip.readUInt16LE(cdOffset + 10),
    compressedSize: zip.readUInt32LE(cdOffset + 20),
    uncompressedSize: zip.readUInt32LE(cdOffset + 24),
    localOffset: zip.readUInt32LE(cdOffset + 42),
  };
}

function findEocd(zip: Buffer): number {
  for (let offset = zip.length - 22; offset >= 0; offset -= 1) {
    if (zip.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new BulkImportError('el fichero no parece un zip: no se encuentra el fin del directorio');
}

/**
 * Saca el unico CSV del zip. El zip es dato no confiable: se rechaza cualquier entrada con ruta,
 * mas de una entrada, un tamano descomprimido por encima del tope o una ratio absurda (zip bomb).
 * La integridad de los bytes ya la garantiza el `.CHECKSUM`, asi que no se revisa el CRC.
 */
export function unzipSingleCsv(
  zipBytes: Uint8Array,
  options: { maxBytes?: number; maxRatio?: number } = {},
): { name: string; csv: string } {
  const maxBytes = options.maxBytes ?? MAX_UNZIPPED_BYTES;
  const maxRatio = options.maxRatio ?? MAX_COMPRESSION_RATIO;
  const zip = Buffer.from(zipBytes);
  const entry = readEntry(zip);

  if (/[/\\]/.test(entry.name) || entry.name.includes('..') || entry.name.startsWith('/')) {
    throw new BulkImportError(`entrada con ruta en el zip, se rechaza: ${entry.name}`);
  }
  if (!entry.name.toLowerCase().endsWith('.csv')) {
    throw new BulkImportError(`la entrada del zip no es un csv: ${entry.name}`);
  }
  if (entry.uncompressedSize > maxBytes) {
    throw new BulkImportError(
      `el csv descomprimido ocuparia ${entry.uncompressedSize} B, por encima del tope de ${maxBytes} B`,
    );
  }
  if (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > maxRatio) {
    throw new BulkImportError(
      `ratio de compresion de ${Math.round(entry.uncompressedSize / entry.compressedSize)}:1, por encima de ${maxRatio}:1`,
    );
  }

  const local = entry.localOffset;
  const localNameLength = zip.readUInt16LE(local + 26);
  const localExtraLength = zip.readUInt16LE(local + 28);
  const dataStart = local + 30 + localNameLength + localExtraLength;
  const data = zip.subarray(dataStart, dataStart + entry.compressedSize);

  const csv =
    entry.method === METHOD_STORED
      ? data
      : entry.method === METHOD_DEFLATE
        ? inflateRawSync(data, { maxOutputLength: maxBytes })
        : (() => {
            throw new BulkImportError(`metodo de compresion no soportado: ${entry.method}`);
          })();

  if (csv.length > maxBytes) {
    throw new BulkImportError(`el csv descomprimido supera el tope de ${maxBytes} B`);
  }

  return { name: entry.name, csv: csv.toString('utf8') };
}

/**
 * El CSV mensual trae las mismas columnas que el REST, en el mismo orden,
 * asi que se reutiliza el normalizador en vez de escribir otro.
 */
export function parseKlineCsv(csv: string, timeframe: Timeframe): NormalizeResult {
  const rows: unknown[] = [];

  for (const line of csv.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    const fields = trimmed.split(',');
    // Desde 2025 algunos ficheros traen cabecera: no es una fila corrupta, se salta.
    if (fields[0] === 'open_time') continue;

    rows.push([
      Number(fields[0]),
      fields[1],
      fields[2],
      fields[3],
      fields[4],
      fields[5],
      Number(fields[6]),
      fields[7],
    ]);
  }

  return normalizeCandles(rows, timeframe);
}

export interface BulkFile {
  kind: 'monthly' | 'daily';
  key: string;
  url: string;
  name: string;
}

export function monthlyFiles(
  symbol: string,
  timeframe: Timeframe,
  from: string,
  to: string,
): BulkFile[] {
  return monthKeys(from, to).map((month) => ({
    kind: 'monthly',
    key: month,
    url: monthlyUrl(symbol, timeframe, month),
    name: monthlyName(symbol, timeframe, month),
  }));
}

/**
 * Los dias de `month` hasta `until` (excluido). El mes en curso no existe como mensual,
 * asi que se cubre con los diarios y el resto por REST.
 */
export function dailyFiles(
  symbol: string,
  timeframe: Timeframe,
  month: string,
  until: number,
): BulkFile[] {
  const start = parseMonth(month);
  const year = Math.floor(start / 12);
  const index = start % 12;
  const files: BulkFile[] = [];

  for (let day = 1; day <= 31; day += 1) {
    const ts = Date.UTC(year, index, day);
    if (new Date(ts).getUTCMonth() !== index) break;
    if (ts >= until) break;

    const key = `${month}-${String(day).padStart(2, '0')}`;
    files.push({
      kind: 'daily',
      key,
      url: dailyUrl(symbol, timeframe, key),
      name: dailyName(symbol, timeframe, key),
    });
  }

  return files;
}

export function isCurrentMonth(month: string, now: number): boolean {
  const date = new Date(now);
  const current = `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  return month === current;
}

export interface FetchedBytes {
  status: number;
  bytes: Uint8Array;
}

export type BytesFetcher = (url: string) => Promise<FetchedBytes>;

export interface BulkFileResult {
  file: BulkFile;
  candles: IngestCandle[];
  discarded: readonly DiscardedRow[];
}

/** Descarga, verifica y parsea un fichero. El upsert lo hace quien llama. */
export async function loadBulkFile(
  file: BulkFile,
  fetchBytes: BytesFetcher,
  timeframe: Timeframe,
): Promise<BulkFileResult> {
  const zip = await fetchBytes(file.url);
  if (zip.status === 404) {
    throw new BulkImportError(`${file.name} no existe en data.binance.vision (HTTP 404)`);
  }
  if (zip.status >= 400) {
    throw new BulkImportError(`${file.name} respondio HTTP ${zip.status}`);
  }

  const checksum = await fetchBytes(`${file.url}.CHECKSUM`);
  if (checksum.status >= 400) {
    throw new BulkImportError(`${file.name}.CHECKSUM respondio HTTP ${checksum.status}`);
  }
  assertChecksum(zip.bytes, Buffer.from(checksum.bytes).toString('utf8'), file.name);

  const { csv } = unzipSingleCsv(zip.bytes);
  const { candles, discarded } = parseKlineCsv(csv, timeframe);

  return { file, candles, discarded };
}
