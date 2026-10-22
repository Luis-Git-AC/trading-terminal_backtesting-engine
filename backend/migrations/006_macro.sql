SET LOCAL TimeZone = 'UTC';

DO $$
DECLARE
  partition_start timestamptz;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    CREATE TABLE macro_series (
      source       text           NOT NULL,
      series_id    text           NOT NULL,
      ts           timestamptz    NOT NULL,
      value        numeric(30,10) NOT NULL,
      published_at timestamptz    NOT NULL,
      fetched_at   timestamptz    NOT NULL,
      revision     integer        NOT NULL DEFAULT 0,
      CONSTRAINT macro_series_pkey PRIMARY KEY (source, series_id, ts, revision),
      CONSTRAINT macro_series_revision CHECK (revision >= 0)
    );
    PERFORM create_hypertable('macro_series', 'ts', chunk_time_interval => INTERVAL '365 days');
    RAISE NOTICE 'macro_series creada como hypertable de TimescaleDB, chunk_time_interval = 365 dias.';
  ELSE
    CREATE TABLE macro_series (
      source       text           NOT NULL,
      series_id    text           NOT NULL,
      ts           timestamptz    NOT NULL,
      value        numeric(30,10) NOT NULL,
      published_at timestamptz    NOT NULL,
      fetched_at   timestamptz    NOT NULL,
      revision     integer        NOT NULL DEFAULT 0,
      CONSTRAINT macro_series_pkey PRIMARY KEY (source, series_id, ts, revision),
      CONSTRAINT macro_series_revision CHECK (revision >= 0)
    ) PARTITION BY RANGE (ts);

    FOR partition_start IN
      SELECT generate_series(
        TIMESTAMPTZ '1990-01-01 00:00:00+00',
        date_trunc('year', now()) + INTERVAL '2 years',
        INTERVAL '1 year'
      )
    LOOP
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF macro_series FOR VALUES FROM (%L) TO (%L)',
        'macro_series_' || to_char(partition_start, 'YYYY'),
        partition_start,
        partition_start + INTERVAL '1 year'
      );
    END LOOP;

    CREATE INDEX macro_series_ts_brin_idx ON macro_series USING brin (ts);
    RAISE WARNING 'TimescaleDB no disponible: macro_series creada particionada por rango anual con indice BRIN sobre ts (ADR-002).';
  END IF;

  CREATE INDEX macro_series_series_ts_idx ON macro_series (series_id, ts DESC);
  CREATE INDEX macro_series_fetched_idx ON macro_series (series_id, fetched_at);
END
$$;

CREATE TABLE market_events (
  id           uuid        NOT NULL DEFAULT gen_random_uuid(),
  source       text        NOT NULL,
  type         text        NOT NULL,
  asset_tags   text[]      NOT NULL DEFAULT '{}',
  scheduled_at timestamptz NOT NULL,
  published_at timestamptz NOT NULL,
  fetched_at   timestamptz NOT NULL,
  payload      jsonb       NOT NULL,
  content_hash text        NOT NULL,
  CONSTRAINT market_events_pkey PRIMARY KEY (id),
  CONSTRAINT market_events_content_hash_key UNIQUE (content_hash)
);

CREATE INDEX market_events_scheduled_idx ON market_events (scheduled_at DESC);
CREATE INDEX market_events_tags_idx ON market_events USING gin (asset_tags);
CREATE INDEX market_events_fetched_idx ON market_events (fetched_at);
