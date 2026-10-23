-- Indices de la busqueda hibrida de F10-T4. Numerada 010 porque la 009 ya estaba aplicada y las
-- migraciones son inmutables (docs/02-DATA-MODEL.md); el ticket las ponia dentro de la de embeddings.

-- Una columna generada tiene que ser IMMUTABLE, y `to_tsvector(lang::regconfig, ...)` no lo es
-- porque el cast de texto a regconfig depende del catalogo. Esta funcion fija la correspondencia
-- idioma -> configuracion y la declara inmutable, que es lo que permite el `GENERATED ALWAYS`.
CREATE OR REPLACE FUNCTION tt_tsconfig(lang text) RETURNS regconfig
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  AS $$
    SELECT CASE lower(coalesce(lang, ''))
      WHEN 'es' THEN 'spanish'::regconfig
      WHEN 'en' THEN 'english'::regconfig
      -- `simple` no hace stemming: para un idioma que no conocemos es mejor no inventarlo.
      ELSE 'simple'::regconfig
    END
  $$;

ALTER TABLE raw_documents
  ADD COLUMN IF NOT EXISTS search_tsv tsvector
  GENERATED ALWAYS AS (
    to_tsvector(tt_tsconfig(lang), coalesce(title, '') || ' ' || coalesce(body, ''))
  ) STORED;

CREATE INDEX IF NOT EXISTS raw_documents_search_idx ON raw_documents USING gin (search_tsv);

DO $$
BEGIN
  IF to_regclass('public.document_embeddings') IS NULL THEN
    RAISE WARNING 'document_embeddings no existe (pgvector no disponible): no se crea el indice vectorial y la busqueda ira solo con full-text.';
    RETURN;
  END IF;

  -- Coseno porque los vectores salen normalizados del modelo (`normalize: true`), y HNSW en vez
  -- de IVFFlat porque no necesita entrenarse con un corpus ya cargado.
  CREATE INDEX IF NOT EXISTS document_embeddings_hnsw_idx
    ON document_embeddings USING hnsw (embedding vector_cosine_ops);
  RAISE NOTICE 'indice HNSW de document_embeddings creado (vector_cosine_ops).';
END
$$;
