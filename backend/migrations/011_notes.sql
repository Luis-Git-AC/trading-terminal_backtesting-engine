-- Numerada 011 porque F10-T4 ocupo la 010 (ver PROGRESS.md); el ticket la llamaba 009_notes.sql.
--
-- Notas escritas por Claude o por el usuario. Obsidian es una vista, no almacenamiento (ADR-006):
-- la fuente de verdad es esta tabla y el export es reconstruible desde aqui.
CREATE TABLE notes (
  id                  uuid        NOT NULL DEFAULT gen_random_uuid(),
  author              text        NOT NULL,
  asset_tags          text[]      NOT NULL DEFAULT '{}',
  body_md             text        NOT NULL,
  -- De que documentos sale la nota. Sin FK a proposito: el crudo puede purgarse y la nota sigue
  -- siendo valida; lo que se pierde es el enlace, no el contenido.
  source_document_ids uuid[]      NOT NULL DEFAULT '{}',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notes_pkey PRIMARY KEY (id),
  -- Las notas de Claude nunca son input de un backtest, y para distinguirlas hay que poder confiar
  -- en este campo: la lista cerrada lo garantiza en la base de datos, no solo en el codigo.
  CONSTRAINT notes_author CHECK (author IN ('claude', 'user'))
);

CREATE INDEX notes_created_idx ON notes (created_at DESC);
CREATE INDEX notes_tags_idx ON notes USING gin (asset_tags);
