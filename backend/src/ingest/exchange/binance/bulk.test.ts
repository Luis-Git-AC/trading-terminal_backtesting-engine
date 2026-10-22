import { Buffer } from 'node:buffer';
import { crc32 } from 'node:zlib';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  BulkImportError,
  assertChecksum,
  dailyFiles,
  dailyUrl,
  isCurrentMonth,
  loadBulkFile,
  monthKeys,
  monthlyFiles,
  monthlyUrl,
  parseKlineCsv,
  sha256,
  unzipSingleCsv,
  type BytesFetcher,
} from './bulk.js';

/** Zip de una sola entrada, hecho a mano para no depender de ningun paquete. */
function makeZip(
  name: string,
  content: Buffer,
  options: { stored?: boolean; entries?: number; uncompressedSize?: number } = {},
): Buffer {
  const stored = options.stored ?? false;
  const data = stored ? content : deflateRawSync(content);
  const nameBytes = Buffer.from(name, 'utf8');
  const uncompressed = options.uncompressedSize ?? content.length;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(stored ? 0 : 8, 8);
  local.writeUInt32LE(crc32(content), 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(uncompressed, 22);
  local.writeUInt16LE(nameBytes.length, 26);

  const localBlock = Buffer.concat([local, nameBytes, data]);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(stored ? 0 : 8, 10);
  central.writeUInt32LE(crc32(content), 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(uncompressed, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(0, 42);

  const centralBlock = Buffer.concat([central, nameBytes]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(options.entries ?? 1, 8);
  eocd.writeUInt16LE(options.entries ?? 1, 10);
  eocd.writeUInt32LE(centralBlock.length, 12);
  eocd.writeUInt32LE(localBlock.length, 16);

  return Buffer.concat([localBlock, centralBlock, eocd]);
}

const CSV = [
  '1767225600000,87608.30,87791.90,87600.00,87705.00,752.615,1767226499999,65994654.30960,15400,447.032,39204593.95500,0',
  '1767226500000,87705.00,87754.00,87705.00,87746.40,236.900,1767227399999,20784197.84670,6366,140.831,12355474.63830,0',
].join('\n');

describe('monthKeys', () => {
  it('enumera los meses de los dos extremos, incluidos', () => {
    expect(monthKeys('2024-11', '2025-02')).toEqual(['2024-11', '2024-12', '2025-01', '2025-02']);
    expect(monthKeys('2024-03', '2024-03')).toEqual(['2024-03']);
  });

  it('rechaza un formato que no sea YYYY-MM y un rango invertido', () => {
    expect(() => monthKeys('2024-1', '2024-02')).toThrow(BulkImportError);
    expect(() => monthKeys('2024-13', '2024-14')).toThrow(BulkImportError);
    expect(() => monthKeys('2024-05', '2024-04')).toThrow(/anterior/);
  });
});

describe('urls', () => {
  it('apuntan a las rutas de futuros USDⓈ-M', () => {
    expect(monthlyUrl('BTCUSDT', '1h', '2024-01')).toBe(
      'https://data.binance.vision/data/futures/um/monthly/klines/BTCUSDT/1h/BTCUSDT-1h-2024-01.zip',
    );
    expect(dailyUrl('BTCUSDT', '1m', '2024-01-05')).toBe(
      'https://data.binance.vision/data/futures/um/daily/klines/BTCUSDT/1m/BTCUSDT-1m-2024-01-05.zip',
    );
  });
});

describe('dailyFiles', () => {
  it('cubre el mes en curso dia a dia hasta ayer, sin incluir hoy', () => {
    const today = Date.UTC(2026, 9, 22);

    const files = dailyFiles('BTCUSDT', '1h', '2026-10', today);

    expect(files).toHaveLength(21);
    expect(files[0]?.key).toBe('2026-10-01');
    expect(files.at(-1)?.key).toBe('2026-10-21');
    expect(files[0]?.kind).toBe('daily');
  });

  it('no se pasa del ultimo dia del mes', () => {
    expect(dailyFiles('BTCUSDT', '1h', '2026-02', Date.UTC(2026, 2, 15))).toHaveLength(28);
  });

  it('isCurrentMonth distingue el mes en curso del resto', () => {
    const now = Date.UTC(2026, 9, 22);
    expect(isCurrentMonth('2026-10', now)).toBe(true);
    expect(isCurrentMonth('2026-09', now)).toBe(false);
  });
});

describe('assertChecksum', () => {
  it('acepta el formato <sha256>  <nombre>', () => {
    const bytes = Buffer.from('hola');
    expect(() =>
      assertChecksum(bytes, `${sha256(bytes)}  BTCUSDT-1h-2024-01.zip\n`, 'x.zip'),
    ).not.toThrow();
  });

  it('un sha que no cuadra aborta nombrando los dos valores', () => {
    expect(() => assertChecksum(Buffer.from('hola'), `${'0'.repeat(64)}  x.zip`, 'x.zip')).toThrow(
      /no cuadra/,
    );
  });

  it('un .CHECKSUM ilegible aborta', () => {
    expect(() => assertChecksum(Buffer.from('hola'), 'no-es-un-sha', 'x.zip')).toThrow(/legible/);
  });
});

describe('unzipSingleCsv', () => {
  it('saca el csv de un zip deflate y de uno almacenado', () => {
    expect(unzipSingleCsv(makeZip('BTCUSDT-1h-2024-01.csv', Buffer.from(CSV))).csv).toBe(CSV);
    expect(
      unzipSingleCsv(makeZip('BTCUSDT-1h-2024-01.csv', Buffer.from(CSV), { stored: true })).csv,
    ).toBe(CSV);
  });

  it('rechaza una entrada con ruta: nada escribe fuera de su sitio', () => {
    expect(() => unzipSingleCsv(makeZip('../x.csv', Buffer.from(CSV)))).toThrow(/ruta/);
    expect(() => unzipSingleCsv(makeZip('sub/x.csv', Buffer.from(CSV)))).toThrow(/ruta/);
  });

  it('rechaza un zip con mas de una entrada', () => {
    expect(() => unzipSingleCsv(makeZip('x.csv', Buffer.from(CSV), { entries: 2 }))).toThrow(
      /entradas/,
    );
  });

  it('rechaza una ratio de compresion absurda antes de descomprimir', () => {
    const bomb = makeZip('x.csv', Buffer.alloc(100_000, 0), { uncompressedSize: 100_000 });
    expect(() => unzipSingleCsv(bomb, { maxRatio: 10 })).toThrow(/ratio/);
  });

  it('rechaza un csv por encima del tope de tamano', () => {
    expect(() => unzipSingleCsv(makeZip('x.csv', Buffer.from(CSV)), { maxBytes: 10 })).toThrow(
      /tope/,
    );
  });

  it('rechaza una entrada que no es csv y un fichero que no es zip', () => {
    expect(() => unzipSingleCsv(makeZip('x.txt', Buffer.from(CSV)))).toThrow(/csv/);
    expect(() => unzipSingleCsv(Buffer.from('no soy un zip'))).toThrow(/zip/);
  });
});

describe('parseKlineCsv', () => {
  it('reutiliza el normalizador del REST: velas alineadas y con quote volume', () => {
    const { candles, discarded } = parseKlineCsv(CSV, '15m');

    expect(discarded).toEqual([]);
    expect(candles.map((candle) => candle.t)).toEqual([1_767_225_600_000, 1_767_226_500_000]);
    expect(candles[0]?.q).toBeCloseTo(65_994_654.3096, 3);
  });

  it('salta la cabecera y las lineas vacias, y descarta las filas corruptas', () => {
    const csv = ['open_time,open,high,low,close,volume', CSV, '', '1767227400000,1,2'].join('\n');

    const { candles, discarded } = parseKlineCsv(csv, '15m');

    expect(candles).toHaveLength(2);
    expect(discarded.map((row) => row.reason)).toEqual(['malformed']);
  });
});

describe('loadBulkFile', () => {
  function fetcher(zip: Buffer, checksum?: string): BytesFetcher {
    return (url) =>
      Promise.resolve(
        url.endsWith('.CHECKSUM')
          ? { status: 200, bytes: Buffer.from(checksum ?? `${sha256(zip)}  x.zip`) }
          : { status: 200, bytes: zip },
      );
  }

  const [file] = monthlyFiles('BTCUSDT', '15m', '2026-01', '2026-01');

  it('verifica el checksum antes de descomprimir y devuelve las velas', async () => {
    const zip = makeZip('BTCUSDT-15m-2026-01.csv', Buffer.from(CSV));
    if (file === undefined) expect.unreachable('falta el fichero mensual');

    const result = await loadBulkFile(file, fetcher(zip), '15m');

    expect(result.candles).toHaveLength(2);
  });

  it('un checksum que no cuadra aborta ese fichero sin parsear nada', async () => {
    const zip = makeZip('BTCUSDT-15m-2026-01.csv', Buffer.from(CSV));
    if (file === undefined) expect.unreachable('falta el fichero mensual');

    await expect(loadBulkFile(file, fetcher(zip, `${'0'.repeat(64)}  x.zip`), '15m')).rejects.toThrow(
      BulkImportError,
    );
  });

  it('un 404 se explica por su nombre: ese mes no existe', async () => {
    if (file === undefined) expect.unreachable('falta el fichero mensual');

    await expect(
      loadBulkFile(file, () => Promise.resolve({ status: 404, bytes: new Uint8Array() }), '15m'),
    ).rejects.toThrow(/no existe/);
  });
});
