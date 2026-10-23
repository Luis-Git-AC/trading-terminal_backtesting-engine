/** Tamanos en caracteres. ~1200 caracteres son ~300 tokens, dentro de los 512 del modelo. */
export const CHUNK_CHARS = 1200;
export const CHUNK_OVERLAP_CHARS = 200;

export interface ChunkOptions {
  readonly size?: number;
  readonly overlap?: number;
}

/** Un parrafo mas largo que el presupuesto se corta en trozos de ese tamano exacto. */
function split(text: string, budget: number): string[] {
  if (text.length <= budget) return [text];

  const pieces: string[] = [];
  for (let start = 0; start < text.length; start += budget) {
    pieces.push(text.slice(start, start + budget));
  }
  return pieces;
}

/**
 * Trocea por parrafos con solape, tamano fijo en caracteres y **determinista**: el mismo documento
 * da siempre los mismos trozos. Se agrupan parrafos hasta llenar el presupuesto y solo se corta por
 * dentro el parrafo que no cabe entero, porque cortar por parrafo conserva la frase.
 *
 * El presupuesto de contenido es `size - overlap`, y el solape se anade despues: asi ningun trozo
 * pasa de `size`, que es la unica garantia que le importa al modelo.
 *
 * El titulo va delante como un parrafo mas: es la frase que mas informa de que va el documento.
 */
export function chunkDocument(
  document: { readonly title: string; readonly body: string },
  options: ChunkOptions = {},
): string[] {
  const size = Math.max(1, Math.trunc(options.size ?? CHUNK_CHARS));
  const overlap = Math.min(
    Math.max(0, Math.trunc(options.overlap ?? CHUNK_OVERLAP_CHARS)),
    Math.max(0, Math.trunc((size - 1) / 2)),
  );
  // El `-1` es el salto de linea con el que se pega el solape.
  const budget = overlap === 0 ? size : size - overlap - 1;

  const units = [document.title, ...document.body.split(/\n\s*\n/u)]
    .map((unit) => unit.replace(/\s+/gu, ' ').trim())
    .filter((unit) => unit.length > 0)
    .flatMap((unit) => split(unit, budget));

  const packed: string[] = [];
  let current = '';

  for (const unit of units) {
    const candidate = current.length === 0 ? unit : `${current}\n${unit}`;
    if (candidate.length <= budget) {
      current = candidate;
      continue;
    }
    if (current.length > 0) packed.push(current);
    current = unit;
  }
  if (current.length > 0) packed.push(current);

  // Secuencial y sobre lo ya emitido: cada trozo empieza por el final del trozo anterior tal y
  // como se guarda, que es lo que da continuidad al leerlos en orden.
  const chunks: string[] = [];
  for (const chunk of packed) {
    const previous = chunks.at(-1);
    chunks.push(
      previous === undefined || overlap === 0 ? chunk : `${previous.slice(-overlap)}\n${chunk}`,
    );
  }
  return chunks;
}
