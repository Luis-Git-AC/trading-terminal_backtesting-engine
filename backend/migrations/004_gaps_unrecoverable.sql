-- Un hueco anterior a la ventana de histórico del exchange no se puede rellenar nunca.
-- Se cierra como cualquier otro (filled_at deja de estar NULL, así que el índice parcial
-- ingest_gaps_open_idx sigue siendo la fuente de "huecos abiertos") y `resolution` dice por qué.
ALTER TABLE ingest_gaps ADD COLUMN IF NOT EXISTS resolution text;

UPDATE ingest_gaps
SET resolution = CASE WHEN last_error = 'no-data-upstream' THEN 'no-data-upstream' ELSE 'filled' END
WHERE filled_at IS NOT NULL AND resolution IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ingest_gaps_resolution_valid'
  ) THEN
    ALTER TABLE ingest_gaps ADD CONSTRAINT ingest_gaps_resolution_valid CHECK (
      (filled_at IS NULL AND resolution IS NULL)
      OR resolution IN ('filled', 'no-data-upstream', 'unrecoverable')
    );
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS ingest_gaps_resolution_idx
  ON ingest_gaps (exchange, symbol, timeframe, resolution)
  WHERE resolution IS NOT NULL;
