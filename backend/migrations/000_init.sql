CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS timescaledb;
EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING 'TimescaleDB no disponible (%). Se continua sin la extension: candles usara el fallback particionado por rango de ADR-002.', SQLERRM;
END
$$;
