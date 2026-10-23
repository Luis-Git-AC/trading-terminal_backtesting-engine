-- Numerada 009 y no 008: F10-T2 ocupo la 008 porque la 007 ya estaba aplicada (ver PROGRESS.md).
--
-- `pgvector` puede no estar en el Postgres de la maquina. Mismo patron que ADR-002 con TimescaleDB:
-- se comprueba, y si falta la migracion no revienta — avisa y deja el sistema con solo full-text.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    CREATE EXTENSION IF NOT EXISTS vector;

    -- La dimension esta en el tipo de la columna, asi que cambiar de modelo es una migracion.
    -- `model` forma parte de la clave para poder convivir con dos durante el cambio.
    CREATE TABLE IF NOT EXISTS document_embeddings (
      document_id uuid        NOT NULL REFERENCES raw_documents (id) ON DELETE CASCADE,
      chunk_idx   integer     NOT NULL,
      chunk_text  text        NOT NULL,
      embedding   vector(384) NOT NULL,
      model       text        NOT NULL,
      created_at  timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT document_embeddings_pkey PRIMARY KEY (document_id, chunk_idx, model),
      CONSTRAINT document_embeddings_chunk_idx CHECK (chunk_idx >= 0)
    );

    -- El indice vectorial (HNSW) lo crea F10-T4, que es quien hace la busqueda.
    RAISE NOTICE 'pgvector disponible: document_embeddings creada con vector(384).';
  ELSE
    RAISE WARNING 'pgvector no esta disponible: no se crea document_embeddings y la busqueda de F10-T4 funcionara solo con full-text. Instala la extension y vuelve a migrar para activar los embeddings.';
  END IF;
END
$$;
