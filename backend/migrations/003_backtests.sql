SET LOCAL TimeZone = 'UTC';

CREATE TABLE IF NOT EXISTS backtest_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status         text NOT NULL DEFAULT 'queued',
  exchange       text NOT NULL,
  symbol         text NOT NULL,
  timeframe      text NOT NULL,
  strategy_id    text NOT NULL,
  params         jsonb NOT NULL,
  exec_config    jsonb NOT NULL,
  seed           bigint NOT NULL,
  range_from     timestamptz NOT NULL,
  range_to       timestamptz NOT NULL,
  engine_version text NOT NULL,
  params_hash    text NOT NULL,
  label          text,
  metrics        jsonb,
  bars_total     int,
  bars_done      int NOT NULL DEFAULT 0,
  error          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  started_at     timestamptz,
  finished_at    timestamptz,
  CONSTRAINT backtest_runs_status_valid
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  CONSTRAINT backtest_runs_timeframe_valid CHECK (timeframe IN ('1m', '15m', '1h')),
  CONSTRAINT backtest_runs_range_ordered CHECK (range_to > range_from),
  CONSTRAINT backtest_runs_bars_done_sane CHECK (bars_done >= 0)
);

CREATE INDEX IF NOT EXISTS backtest_runs_created_idx ON backtest_runs (created_at DESC);
CREATE INDEX IF NOT EXISTS backtest_runs_hash_idx ON backtest_runs (params_hash);
CREATE INDEX IF NOT EXISTS backtest_runs_status_idx ON backtest_runs (status, created_at DESC);

CREATE TABLE IF NOT EXISTS backtest_trades (
  run_id      uuid NOT NULL REFERENCES backtest_runs(id) ON DELETE CASCADE,
  seq         int  NOT NULL,
  side        text NOT NULL,
  entry_ts    timestamptz NOT NULL,
  entry_price numeric(24,10) NOT NULL,
  exit_ts     timestamptz NOT NULL,
  exit_price  numeric(24,10) NOT NULL,
  qty         numeric(30,10) NOT NULL,
  fees        numeric(24,10) NOT NULL,
  pnl_quote   numeric(24,10) NOT NULL,
  pnl_r       numeric(12,6)  NOT NULL,
  exit_reason text NOT NULL,
  mae_r       numeric(12,6),
  mfe_r       numeric(12,6),
  PRIMARY KEY (run_id, seq),
  CONSTRAINT backtest_trades_side_valid CHECK (side IN ('long', 'short')),
  CONSTRAINT backtest_trades_reason_valid
    CHECK (exit_reason IN ('stop', 'take-profit', 'signal', 'end-of-data')),
  CONSTRAINT backtest_trades_seq_positive CHECK (seq >= 1),
  CONSTRAINT backtest_trades_time_ordered CHECK (exit_ts >= entry_ts)
);

CREATE TABLE IF NOT EXISTS backtest_equity (
  run_id   uuid NOT NULL REFERENCES backtest_runs(id) ON DELETE CASCADE,
  ts       timestamptz NOT NULL,
  equity   numeric(24,10) NOT NULL,
  drawdown numeric(12,6)  NOT NULL,
  PRIMARY KEY (run_id, ts),
  CONSTRAINT backtest_equity_drawdown_fraction CHECK (drawdown >= 0 AND drawdown <= 1)
);
