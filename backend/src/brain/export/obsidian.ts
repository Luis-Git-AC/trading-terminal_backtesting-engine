import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Todo lo generado vive bajo esta carpeta del vault: nunca se toca nada de fuera. */
export const VAULT_FOLDER = 'trading-terminal';

/** La marca que distingue un fichero nuestro de una nota del usuario. */
export const GENERATED_BY = 'trading-terminal';

/** Un nombre de fichero largo revienta en Windows y en algunos sistemas de ficheros. */
export const MAX_SLUG_CHARS = 80;

export type ConflictReason =
  /** El fichero existe y no lleva nuestra marca: es una nota del usuario. */
  | 'ajeno'
  /** Lleva la marca pero su cuerpo ya no coincide con el hash: lo editaron a mano. */
  | 'editado-a-mano';

export interface ExportConflict {
  readonly path: string;
  readonly reason: ConflictReason;
}

export interface ExportReport {
  readonly written: readonly string[];
  readonly unchanged: readonly string[];
  readonly conflicts: readonly ExportConflict[];
}

export interface VaultFile {
  /** Ruta relativa a `VAULT_FOLDER`, ya saneada por `safeFileName`. */
  readonly path: string;
  /** Pares del frontmatter que acompanan a la marca; los valores se escriben tal cual. */
  readonly frontmatter: Readonly<Record<string, string>>;
  readonly body: string;
}

/** Punto de inyeccion de los tests: no hay otra forma de provocar un fallo a mitad de escritura. */
export interface VaultFs {
  mkdir(path: string): Promise<void>;
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

export const nodeVaultFs: VaultFs = {
  mkdir: async (path) => {
    await mkdir(path, { recursive: true });
  },
  readFile: async (path) => {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  },
  writeFile: async (path, content) => {
    await writeFile(path, content, 'utf8');
  },
  rename: async (from, to) => {
    await rename(from, to);
  },
  unlink: async (path) => {
    try {
      await unlink(path);
    } catch {
      // El temporal puede no existir si el fallo fue al crearlo: no hay nada que limpiar.
    }
  },
};

/**
 * El titulo de un feed es dato no confiable y aqui se convierte en un path. Se queda solo con
 * letras, numeros y guiones: asi no hay `/`, `\`, `:`, `..` ni caracteres de control que puedan
 * sacar la escritura de la carpeta del vault.
 */
export function safeFileName(title: string, fallback: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, MAX_SLUG_CHARS)
    .replace(/-+$/u, '');

  // Un titulo que se queda en nada (emojis, otro alfabeto) no puede dejar el nombre vacio.
  return slug.length === 0 ? fallback : slug;
}

export function contentHash(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

function renderFrontmatter(file: VaultFile, hash: string): string {
  const lines = [
    '---',
    `generated_by: ${GENERATED_BY}`,
    `content_hash: ${hash}`,
    ...Object.entries(file.frontmatter).map(([key, value]) => `${key}: ${value}`),
    '---',
    '',
  ];
  return lines.join('\n');
}

interface Existing {
  readonly generated: boolean;
  readonly declaredHash: string | null;
  readonly body: string;
}

/** Separa el frontmatter del cuerpo. Un fichero sin frontmatter es, por definicion, ajeno. */
export function parseExisting(content: string): Existing {
  const match = /^---\n([\s\S]*?)\n---\n?/u.exec(content);
  if (match?.[1] === undefined) return { generated: false, declaredHash: null, body: content };

  const header = match[1];
  const body = content.slice(match[0].length);
  const generated = new RegExp(`^generated_by:\\s*${GENERATED_BY}\\s*$`, 'mu').test(header);
  const hash = /^content_hash:\s*([0-9a-f]{64})\s*$/mu.exec(header);

  return { generated, declaredHash: hash?.[1] ?? null, body };
}

/**
 * Escribe un fichero del vault si y solo si es nuestro y ha cambiado.
 *
 * - Sin marca o con el cuerpo editado a mano: no se toca y se devuelve el conflicto. Esta es la
 *   regla que evita destruir el vault personal del usuario.
 * - Mismo contenido: no se reescribe, para que Obsidian no vea cambiar la nota en pantalla.
 * - Atomico: temporal en la misma carpeta y `rename`. Un vault es un arbol que Obsidian esta
 *   leyendo a la vez, y media escritura visible es una nota corrupta.
 */
export async function writeVaultFile(
  fs: VaultFs,
  root: string,
  file: VaultFile,
): Promise<{ state: 'written' | 'unchanged'; conflict?: ExportConflict }> {
  const target = join(root, VAULT_FOLDER, file.path);
  const hash = contentHash(file.body);
  const content = `${renderFrontmatter(file, hash)}${file.body}`;

  const previous = await fs.readFile(target);
  if (previous !== null) {
    const existing = parseExisting(previous);

    if (!existing.generated) {
      return { state: 'unchanged', conflict: { path: file.path, reason: 'ajeno' } };
    }
    if (existing.declaredHash !== contentHash(existing.body)) {
      return { state: 'unchanged', conflict: { path: file.path, reason: 'editado-a-mano' } };
    }
    if (existing.declaredHash === hash) return { state: 'unchanged' };
  }

  await fs.mkdir(join(root, VAULT_FOLDER, dirnameOf(file.path)));

  // El temporal va en la carpeta destino: `rename` solo es atomico dentro del mismo volumen.
  const temporary = `${target}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    await fs.writeFile(temporary, content);
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.unlink(temporary);
    throw error;
  }

  return { state: 'written' };
}

/** `path.dirname` con separadores de POSIX: las rutas del vault se construyen aqui con `/`. */
function dirnameOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut <= 0 ? '.' : path.slice(0, cut);
}

export async function writeVaultFiles(
  fs: VaultFs,
  root: string,
  files: readonly VaultFile[],
): Promise<ExportReport> {
  const written: string[] = [];
  const unchanged: string[] = [];
  const conflicts: ExportConflict[] = [];

  for (const file of files) {
    const result = await writeVaultFile(fs, root, file);
    if (result.conflict !== undefined) conflicts.push(result.conflict);
    else if (result.state === 'written') written.push(file.path);
    else unchanged.push(file.path);
  }

  return { written, unchanged, conflicts };
}
