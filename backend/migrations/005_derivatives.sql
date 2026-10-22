SET LOCAL TimeZone = 'UTC';

DO $$
DECLARE
  derivative record;
  partition_start timestamptz;
BEGIN
  FOR derivative IN
    SELECT *
    FROM (VALUES
      ('funding_rates', $cols$
    exchange       text           NOT NULL,
    symbol         text           NOT NULL,
    ts             timestamptz    NOT NULL,
    rate           numeric(20,10) NOT NULL,
    interval_hours integer        NOT NULL,
    source         text           NOT NULL,
    ingested_at    timestamptz    NOT NULL DEFAULT now(),
    CONSTRAINT funding_rates_pkey PRIMARY KEY (exchange, symbol, ts),
    CONSTRAINT funding_rates_interval CHECK (interval_hours > 0 AND interval_hours <= 24)
      $cols$),
      ('open_interest', $cols$
    exchange    text           NOT NULL,
    symbol      text           NOT NULL,
    ts          timestamptz    NOT NULL,
    oi_base     numeric(30,10) NOT NULL,
    oi_quote    numeric(30,10),
    source      text           NOT NULL,
    ingested_at timestamptz    NOT NULL DEFAULT now(),
    CONSTRAINT open_interest_pkey PRIMARY KEY (exchange, symbol, ts),
    CONSTRAINT open_interest_sane CHECK (oi_base >= 0 AND (oi_quote IS NULL OR oi_quote >= 0))
      $cols$)
    ) AS t(table_name, columns)
  LOOP
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
      EXECUTE format('CREATE TABLE %I (%s)', derivative.table_name, derivative.columns);
      PERFORM create_hypertable(derivative.table_name, 'ts', chunk_time_interval => INTERVAL '30 days');
      RAISE NOTICE '% creada como hypertable de TimescaleDB, chunk_time_interval = 30 dias.', derivative.table_name;
    ELSE
      EXECUTE format(
        'CREATE TABLE %I (%s) PARTITION BY RANGE (ts)',
        derivative.table_name,
        derivative.columns
      );

      FOR partition_start IN
        SELECT generate_series(
          TIMESTAMPTZ '2020-01-01 00:00:00+00',
          date_trunc('month', now()) + INTERVAL '3 months',
          INTERVAL '1 month'
        )
      LOOP
        EXECUTE format(
          'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
          derivative.table_name || '_' || to_char(partition_start, 'YYYY_MM'),
          derivative.table_name,
          partition_start,
          partition_start + INTERVAL '1 month'
        );
      END LOOP;

      EXECUTE format(
        'CREATE INDEX %I ON %I USING brin (ts)',
        derivative.table_name || '_ts_brin_idx',
        derivative.table_name
      );
      RAISE WARNING 'TimescaleDB no disponible: % creada particionada por rango mensual con indice BRIN sobre ts (ADR-002).', derivative.table_name;
    END IF;

    EXECUTE format(
      'CREATE INDEX %I ON %I (exchange, symbol, ts DESC)',
      derivative.table_name || '_series_ts_idx',
      derivative.table_name
    );
  END LOOP;
END
$$;
