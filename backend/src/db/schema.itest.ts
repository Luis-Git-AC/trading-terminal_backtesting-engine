import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, runMigrations } from './migrate.js';
import { createScratchDatabase, type ScratchDatabase } from '../testing/scratch-db.js';

const INSERT_CANDLE = `
  INSERT INTO candles (exchange, symbol, timeframe, ts, open, high, low, close, volume, source)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
`;

const VALID_CANDLE: string[] = [
  'bitget',
  'BTCUSDT',
  '15m',
  '2026-03-01T00:00:00Z',
  '60000',
  '60500',
  '59800',
  '60200',
  '12.5',
  'rest',
];

function sqlstateOf(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

async function expectSqlstate(promise: Promise<unknown>, code: string): Promise<void> {
  let captured: unknown;
  try {
    await promise;
  } catch (error) {
    captured = error;
  }
  expect(sqlstateOf(captured), `se esperaba SQLSTATE ${code}`).toBe(code);
}

describe('esquema sobre PostgreSQL con TimescaleDB', () => {
  let db: ScratchDatabase;

  beforeAll(async () => {
    db = await createScratchDatabase({ applicationName: 'tt-itest-schema' });
    const result = await runMigrations({ pool: db.pool });
    expect(result.applied).toEqual(['000_init.sql', '001_candles.sql', '002_ingest.sql']);
    expect(result.timescaleVersion).not.toBeNull();
  });

  afterAll(async () => {
    await db.drop();
  });

  describe('candles', () => {
    it('es una hypertable con chunks de 7 dias', async () => {
      const { rows } = await db.pool.query<{ hypertable_name: string; time_interval: string }>(
        `SELECT h.hypertable_name, d.time_interval::text AS time_interval
         FROM timescaledb_information.hypertables h
         JOIN timescaledb_information.dimensions d
           ON d.hypertable_name = h.hypertable_name
         WHERE h.hypertable_name = 'candles'`,
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.time_interval).toBe('7 days');
    });

    it('tiene el indice de serie descendente', async () => {
      const { rows } = await db.pool.query<{ indexdef: string }>(
        "SELECT indexdef FROM pg_indexes WHERE tablename = 'candles' AND indexname = 'candles_series_ts_idx'",
      );

      expect(rows[0]?.indexdef).toContain('ts DESC');
    });

    it('acepta una vela coherente', async () => {
      await db.pool.query(INSERT_CANDLE, [...VALID_CANDLE]);

      const { rows } = await db.pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM candles',
      );
      expect(rows[0]?.count).toBe('1');
    });

    it('rechaza high < low por CHECK', async () => {
      const broken = [...VALID_CANDLE];
      broken[3] = '2026-03-01T00:15:00Z';
      broken[5] = '59000';

      await expectSqlstate(db.pool.query(INSERT_CANDLE, broken), '23514');
    });

    it('rechaza high por debajo de open o close', async () => {
      const broken = [...VALID_CANDLE];
      broken[3] = '2026-03-01T00:30:00Z';
      broken[4] = '61000';

      await expectSqlstate(db.pool.query(INSERT_CANDLE, broken), '23514');
    });

    it('rechaza un timeframe fuera del enum', async () => {
      const broken = [...VALID_CANDLE];
      broken[2] = '4h';

      await expectSqlstate(db.pool.query(INSERT_CANDLE, broken), '23514');
    });

    it('rechaza la misma clave (exchange, symbol, timeframe, ts) dos veces', async () => {
      await expectSqlstate(db.pool.query(INSERT_CANDLE, [...VALID_CANDLE]), '23505');
    });

    it('permite upsert sobre esa clave con ON CONFLICT', async () => {
      await db.pool.query(
        `${INSERT_CANDLE}
         ON CONFLICT (exchange, symbol, timeframe, ts)
         DO UPDATE SET close = EXCLUDED.close, source = EXCLUDED.source`,
        [
          'bitget',
          'BTCUSDT',
          '15m',
          '2026-03-01T00:00:00Z',
          '60000',
          '60500',
          '59800',
          '60450',
          '12.5',
          'ws',
        ],
      );

      const { rows } = await db.pool.query<{ close: string; source: string; count: string }>(
        `SELECT close::text AS close, source, (SELECT count(*)::text FROM candles) AS count
         FROM candles WHERE ts = '2026-03-01T00:00:00Z'`,
      );

      expect(rows[0]?.count).toBe('1');
      expect(rows[0]?.source).toBe('ws');
      expect(Number(rows[0]?.close)).toBe(60450);
    });
  });

  describe('ingest_state e ingest_gaps', () => {
    it('ingest_state tiene PK por serie y defaults', async () => {
      await db.pool.query(
        'INSERT INTO ingest_state (exchange, symbol, timeframe, backfill_target_ts) VALUES ($1,$2,$3,$4)',
        ['bitget', 'BTCUSDT', '1h', '2026-01-01T00:00:00Z'],
      );

      const { rows } = await db.pool.query<{ backfill_done: boolean; updated_at: Date }>(
        'SELECT backfill_done, updated_at FROM ingest_state',
      );
      expect(rows[0]?.backfill_done).toBe(false);
      expect(rows[0]?.updated_at).toBeInstanceOf(Date);

      await expectSqlstate(
        db.pool.query(
          'INSERT INTO ingest_state (exchange, symbol, timeframe, backfill_target_ts) VALUES ($1,$2,$3,$4)',
          ['bitget', 'BTCUSDT', '1h', '2026-02-01T00:00:00Z'],
        ),
        '23505',
      );
    });

    it('ingest_gaps rechaza un rango invertido', async () => {
      await expectSqlstate(
        db.pool.query(
          'INSERT INTO ingest_gaps (exchange, symbol, timeframe, gap_from, gap_to) VALUES ($1,$2,$3,$4,$5)',
          ['bitget', 'BTCUSDT', '1h', '2026-01-02T00:00:00Z', '2026-01-01T00:00:00Z'],
        ),
        '23514',
      );
    });

    it('solo admite un hueco abierto por serie y gap_from, pero varios ya rellenados', async () => {
      const insert =
        'INSERT INTO ingest_gaps (exchange, symbol, timeframe, gap_from, gap_to, filled_at) VALUES ($1,$2,$3,$4,$5,$6)';
      const key = ['bitget', 'BTCUSDT', '1h', '2026-01-05T00:00:00Z', '2026-01-05T03:00:00Z'];

      await db.pool.query(insert, [...key, null]);
      await expectSqlstate(db.pool.query(insert, [...key, null]), '23505');

      await db.pool.query(insert, [...key, '2026-01-06T00:00:00Z']);
      await db.pool.query(insert, [...key, '2026-01-07T00:00:00Z']);

      const { rows } = await db.pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM ingest_gaps WHERE gap_from = $1',
        ['2026-01-05T00:00:00Z'],
      );
      expect(rows[0]?.count).toBe('3');
    });
  });
});

describe('fallback sin TimescaleDB (ADR-002)', () => {
  let db: ScratchDatabase;
  let dir: string;

  beforeAll(async () => {
    db = await createScratchDatabase({
      template: 'template0',
      applicationName: 'tt-itest-fallback',
    });
    dir = await mkdtemp(join(tmpdir(), 'tt-schema-fallback-'));
    await copyFile(join(MIGRATIONS_DIR, '001_candles.sql'), join(dir, '001_candles.sql'));
  });

  afterAll(async () => {
    await db.drop();
    await rm(dir, { recursive: true, force: true });
  });

  it('la base de datos de control no tiene la extension', async () => {
    const { rows } = await db.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM pg_extension WHERE extname = 'timescaledb'",
    );
    expect(rows[0]?.count).toBe('0');
  });

  it('crea candles particionada por rango y avisa por log', async () => {
    const warnings: string[] = [];
    const result = await runMigrations({
      pool: db.pool,
      dir,
      log: (event) => {
        if (event.kind === 'warning' || event.kind === 'notice') warnings.push(event.message);
      },
    });

    expect(result.applied).toEqual(['001_candles.sql']);
    expect(result.timescaleVersion).toBeNull();
    expect(warnings.join('\n')).toMatch(/particionada por rango|no esta instalada/i);

    const { rows } = await db.pool.query<{ relkind: string }>(
      "SELECT relkind::text AS relkind FROM pg_class WHERE relname = 'candles'",
    );
    expect(rows[0]?.relkind).toBe('p');
  });

  it('tiene indice BRIN sobre ts ademas del btree de serie', async () => {
    const { rows } = await db.pool.query<{ indexname: string; indexdef: string }>(
      "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'candles' ORDER BY indexname",
    );
    const definitions = rows.map((row) => row.indexdef).join('\n');

    expect(definitions).toContain('USING brin (ts)');
    expect(definitions).toContain('ts DESC');
  });

  it('crea particiones mensuales con al menos 3 meses de antelacion', async () => {
    const ahead = new Date(Date.now() + 80 * 24 * 60 * 60 * 1000).toISOString();

    await db.pool.query(INSERT_CANDLE, [
      'bitget',
      'BTCUSDT',
      '1h',
      ahead,
      '60000',
      '60500',
      '59800',
      '60200',
      '1',
      'rest',
    ]);

    const { rows } = await db.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM pg_inherits WHERE inhparent = $1::regclass',
      ['candles'],
    );
    expect(Number(rows[0]?.count)).toBeGreaterThan(12);
  });

  it('mantiene los CHECK de coherencia en la tabla particionada', async () => {
    const broken = [...VALID_CANDLE];
    broken[5] = '1';

    await expectSqlstate(db.pool.query(INSERT_CANDLE, broken), '23514');
  });
});
