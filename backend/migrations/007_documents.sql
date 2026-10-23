-- Noticias crudas e inmutables (ADR-006): lo que llego, saneado a texto y nada mas. El etiquetado
-- y los embeddings viven en tablas aparte para poder recalcularlos sin tocar el crudo.
CREATE TABLE raw_documents (
  id           uuid        NOT NULL DEFAULT gen_random_uuid(),
  source       text        NOT NULL,
  url          text        NOT NULL,
  title        text        NOT NULL,
  body         text        NOT NULL,
  content_hash text        NOT NULL,
  published_at timestamptz NOT NULL,
  -- `published_at` copiado de `fetched_at` porque el feed no lo traia o venia en el futuro.
  published_at_estimated boolean NOT NULL DEFAULT false,
  fetched_at   timestamptz NOT NULL,
  lang         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT raw_documents_pkey PRIMARY KEY (id),
  -- El dedupe es por contenido, no por URL: el mismo articulo llega con tracking distinto.
  CONSTRAINT raw_documents_content_hash_key UNIQUE (content_hash)
);

CREATE INDEX raw_documents_published_idx ON raw_documents (published_at DESC);
CREATE INDEX raw_documents_source_published_idx ON raw_documents (source, published_at DESC);
-- Corte point-in-time de ADR-006.
CREATE INDEX raw_documents_fetched_idx ON raw_documents (fetched_at);
