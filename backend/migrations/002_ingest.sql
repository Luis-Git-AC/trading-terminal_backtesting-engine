CREATE TABLE ingest_state (
  exchange           text NOT NULL,
  symbol             text NOT NULL,
  timeframe          text NOT NULL,
  backfill_cursor_ts timestamptz,
  backfill_target_ts timestamptz NOT NULL,
  backfill_done      boolean     NOT NULL DEFAULT false,
  last_candle_ts     timestamptz,
  last_ws_message_at timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ingest_state_pkey PRIMARY KEY (exchange, symbol, timeframe),
  CONSTRAINT ingest_state_tf CHECK (timeframe IN ('1m','15m','1h'))
);

CREATE TABLE ingest_gaps (
  id          bigserial PRIMARY KEY,
  exchange    text NOT NULL,
  symbol      text NOT NULL,
  timeframe   text NOT NULL,
  gap_from    timestamptz NOT NULL,
  gap_to      timestamptz NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT now(),
  filled_at   timestamptz,
  attempts    int  NOT NULL DEFAULT 0,
  last_error  text,
  CONSTRAINT ingest_gaps_range CHECK (gap_to >= gap_from),
  CONSTRAINT ingest_gaps_tf CHECK (timeframe IN ('1m','15m','1h'))
);

CREATE UNIQUE INDEX ingest_gaps_open_idx
  ON ingest_gaps (exchange, symbol, timeframe, gap_from)
  WHERE filled_at IS NULL;
