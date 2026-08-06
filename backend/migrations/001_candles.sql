SET LOCAL TimeZone = 'UTC';

DO $$
DECLARE
  candle_columns constant text := $cols$
    exchange     text           NOT NULL,
    symbol       text           NOT NULL,
    timeframe    text           NOT NULL,
    ts           timestamptz    NOT NULL,
    open         numeric(24,10) NOT NULL,
    high         numeric(24,10) NOT NULL,
    low          numeric(24,10) NOT NULL,
    close        numeric(24,10) NOT NULL,
    volume       numeric(30,10) NOT NULL,
    quote_volume numeric(30,10),
    source       text           NOT NULL,
    ingested_at  timestamptz    NOT NULL DEFAULT now(),
    CONSTRAINT candles_pkey PRIMARY KEY (exchange, symbol, timeframe, ts),
    CONSTRAINT candles_ohlc_sane CHECK (high >= low AND high >= open AND high >= close
                                        AND low <= open AND low <= close),
    CONSTRAINT candles_tf CHECK (timeframe IN ('1m','15m','1h'))
  $cols$;
  partition_start timestamptz;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    EXECUTE format('CREATE TABLE candles (%s)', candle_columns);
    PERFORM create_hypertable('candles', 'ts', chunk_time_interval => INTERVAL '7 days');
    RAISE NOTICE 'candles creada como hypertable de TimescaleDB, chunk_time_interval = 7 dias.';
  ELSE
    EXECUTE format('CREATE TABLE candles (%s) PARTITION BY RANGE (ts)', candle_columns);

    FOR partition_start IN
      SELECT generate_series(
        TIMESTAMPTZ '2020-01-01 00:00:00+00',
        date_trunc('month', now()) + INTERVAL '3 months',
        INTERVAL '1 month'
      )
    LOOP
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF candles FOR VALUES FROM (%L) TO (%L)',
        'candles_' || to_char(partition_start, 'YYYY_MM'),
        partition_start,
        partition_start + INTERVAL '1 month'
      );
    END LOOP;

    CREATE INDEX candles_ts_brin_idx ON candles USING brin (ts);
    RAISE WARNING 'TimescaleDB no disponible: candles creada particionada por rango mensual con indice BRIN sobre ts (ADR-002).';
  END IF;

  CREATE INDEX candles_series_ts_idx ON candles (exchange, symbol, timeframe, ts DESC);
END
$$;
