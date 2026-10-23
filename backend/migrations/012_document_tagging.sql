-- Marca de etiquetado, para que el barrido de `brain` sepa que documentos le faltan.
--
-- `document_tags` solo guarda coincidencias, asi que un documento que ninguna regla toca es
-- indistinguible de uno sin evaluar y el barrido lo reintentaria en cada pasada. El hash de las
-- reglas vigentes resuelve las dos cosas con una columna: distinto del hash actual = pendiente, y
-- cambiar una regla reetiqueta el corpus solo, sin acordarse de subir ningun numero a mano.
ALTER TABLE raw_documents ADD COLUMN tagged_rules_hash text;

-- Indice parcial: lo que se consulta son los pendientes, que en regimen son unos pocos frente al
-- corpus entero.
CREATE INDEX raw_documents_untagged_idx
  ON raw_documents (published_at DESC, id)
  WHERE tagged_rules_hash IS NULL;
