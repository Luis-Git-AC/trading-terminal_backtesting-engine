-- El ticket F10-T2 ponia esta tabla dentro de 007_documents.sql, pero esa migracion ya estaba
-- aplicada y las migraciones son inmutables y solo hacia adelante (docs/02-DATA-MODEL.md).
--
-- `rule_id` forma parte de la clave: la etiqueta recuerda que regla la puso, asi que al cambiar
-- una regla se reetiqueta solo lo que esa regla toco y el resto se queda como estaba.
CREATE TABLE document_tags (
  document_id uuid NOT NULL REFERENCES raw_documents (id) ON DELETE CASCADE,
  asset       text NOT NULL,
  rule_id     text NOT NULL,
  CONSTRAINT document_tags_pkey PRIMARY KEY (document_id, asset, rule_id)
);

-- La consulta normal es la inversa de la PK: dame los documentos de un activo.
CREATE INDEX document_tags_asset_idx ON document_tags (asset, document_id);
-- Reetiquetar por regla: borrar lo que puso una regla sin recorrer la tabla entera.
CREATE INDEX document_tags_rule_idx ON document_tags (rule_id);
