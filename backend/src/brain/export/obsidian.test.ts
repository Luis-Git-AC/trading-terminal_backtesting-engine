import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  contentHash,
  GENERATED_BY,
  MAX_SLUG_CHARS,
  parseExisting,
  safeFileName,
  VAULT_FOLDER,
  writeVaultFile,
  writeVaultFiles,
  type VaultFile,
  type VaultFs,
} from './obsidian.js';

const ROOT = '/vault';

/** Vault en memoria: ningun test toca el disco. */
function memoryFs(options: { readonly failOnWrite?: boolean } = {}) {
  const files = new Map<string, string>();
  const dirs: string[] = [];

  const fs: VaultFs = {
    mkdir: (path) => {
      dirs.push(path);
      return Promise.resolve();
    },
    readFile: (path) => Promise.resolve(files.get(path) ?? null),
    writeFile: (path, content) => {
      if (options.failOnWrite === true) return Promise.reject(new Error('disco lleno'));
      files.set(path, content);
      return Promise.resolve();
    },
    rename: (from, to) => {
      const content = files.get(from);
      if (content === undefined) return Promise.reject(new Error(`no existe ${from}`));
      files.delete(from);
      files.set(to, content);
      return Promise.resolve();
    },
    unlink: (path) => {
      files.delete(path);
      return Promise.resolve();
    },
  };

  return { fs, files, dirs };
}

function file(body: string, path = 'documents/nota.md'): VaultFile {
  return { path, frontmatter: { source: '"coindesk"' }, body };
}

/** `join` y no una plantilla: en Windows el separador es `\` y el test tiene que dar igual. */
const inVault = (relative: string): string => join(ROOT, VAULT_FOLDER, relative);
const TARGET = inVault('documents/nota.md');

describe('safeFileName', () => {
  it('un titulo con rutas relativas no puede salir de la carpeta del vault', () => {
    expect(safeFileName('../../etc/passwd', 'x')).toBe('etc-passwd');
    expect(safeFileName('..\\..\\windows\\system32', 'x')).toBe('windows-system32');
  });

  it('se lleva los dos puntos y los separadores', () => {
    expect(safeFileName('Fed: rates on hold', 'x')).toBe('fed-rates-on-hold');
    expect(safeFileName('a/b\\c:d', 'x')).toBe('a-b-c-d');
  });

  it('un titulo que se queda en nada usa el respaldo', () => {
    expect(safeFileName('🚀🚀', 'abc12345')).toBe('abc12345');
    expect(safeFileName('   ', 'abc12345')).toBe('abc12345');
    expect(safeFileName('...', 'abc12345')).toBe('abc12345');
  });

  it('quita acentos y recorta la longitud', () => {
    expect(safeFileName('Año récord del petróleo', 'x')).toBe('ano-record-del-petroleo');
    expect(safeFileName('a'.repeat(200), 'x')).toHaveLength(MAX_SLUG_CHARS);
  });

  it('nunca deja caracteres de control ni nulos', () => {
    expect(safeFileName('a\u0000b\nc', 'x')).toBe('a-b-c');
  });
});

describe('parseExisting', () => {
  it('un fichero sin frontmatter es ajeno', () => {
    expect(parseExisting('# mi nota')).toMatchObject({ generated: false, declaredHash: null });
  });

  it('un frontmatter de otro no lleva nuestra marca', () => {
    const contenido = '---\ntags: [personal]\n---\n# mi nota\n';
    expect(parseExisting(contenido)).toMatchObject({ generated: false, body: '# mi nota\n' });
  });

  it('separa marca, hash y cuerpo de uno nuestro', () => {
    const hash = contentHash('cuerpo');
    const contenido = `---\ngenerated_by: ${GENERATED_BY}\ncontent_hash: ${hash}\n---\ncuerpo`;
    expect(parseExisting(contenido)).toEqual({
      generated: true,
      declaredHash: hash,
      body: 'cuerpo',
    });
  });
});

describe('writeVaultFile', () => {
  it('escribe el fichero con la marca y su hash', async () => {
    const { fs, files } = memoryFs();
    expect(await writeVaultFile(fs, ROOT, file('cuerpo nuevo'))).toEqual({ state: 'written' });

    const contenido = files.get(TARGET)!;
    expect(contenido).toContain(`generated_by: ${GENERATED_BY}`);
    expect(contenido).toContain(`content_hash: ${contentHash('cuerpo nuevo')}`);
    expect(contenido.endsWith('cuerpo nuevo')).toBe(true);
    expect(files.size).toBe(1);
  });

  it('es atomico: escribe en un temporal y lo renombra', async () => {
    const { fs, files } = memoryFs();
    const renames: string[] = [];
    await writeVaultFile(
      {
        ...fs,
        rename: (from, to) => {
          renames.push(from);
          return fs.rename(from, to);
        },
      },
      ROOT,
      file('cuerpo'),
    );

    expect(renames[0]).toMatch(/\.tmp$/u);
    expect([...files.keys()]).toEqual([TARGET]);
  });

  it('un fallo a mitad no deja ni el .md ni el temporal', async () => {
    const { fs, files } = memoryFs({ failOnWrite: true });

    await expect(writeVaultFile(fs, ROOT, file('cuerpo'))).rejects.toThrow('disco lleno');
    expect(files.size).toBe(0);
  });

  it('un fallo en el rename limpia el temporal y no deja un .md truncado', async () => {
    const { fs, files } = memoryFs();
    const roto: VaultFs = { ...fs, rename: () => Promise.reject(new Error('rename roto')) };

    await expect(writeVaultFile(roto, ROOT, file('cuerpo'))).rejects.toThrow('rename roto');
    expect(files.has(TARGET)).toBe(false);
    expect([...files.keys()]).toEqual([]);
  });

  it('el mismo contenido no se reescribe', async () => {
    const { fs, files } = memoryFs();
    await writeVaultFile(fs, ROOT, file('igual'));
    const antes = files.get(TARGET);

    expect(await writeVaultFile(fs, ROOT, file('igual'))).toEqual({ state: 'unchanged' });
    expect(files.get(TARGET)).toBe(antes);
  });

  it('un contenido distinto si se reescribe', async () => {
    const { fs, files } = memoryFs();
    await writeVaultFile(fs, ROOT, file('viejo'));

    expect(await writeVaultFile(fs, ROOT, file('nuevo'))).toEqual({ state: 'written' });
    expect(files.get(TARGET)).toContain('nuevo');
  });

  it('un fichero del usuario no se toca y queda como conflicto', async () => {
    const { fs, files } = memoryFs();
    files.set(TARGET, '# mi nota personal\n');

    expect(await writeVaultFile(fs, ROOT, file('lo nuestro'))).toEqual({
      state: 'unchanged',
      conflict: { path: 'documents/nota.md', reason: 'ajeno' },
    });
    expect(files.get(TARGET)).toBe('# mi nota personal\n');
  });

  it('uno nuestro editado a mano tampoco se sobrescribe', async () => {
    const { fs, files } = memoryFs();
    await writeVaultFile(fs, ROOT, file('original'));
    // El usuario edita el cuerpo y deja el hash viejo en el frontmatter.
    const editado = files.get(TARGET)!.replace('original', 'original, y esto lo anadi yo');
    files.set(TARGET, editado);

    expect(await writeVaultFile(fs, ROOT, file('otra version'))).toEqual({
      state: 'unchanged',
      conflict: { path: 'documents/nota.md', reason: 'editado-a-mano' },
    });
    expect(files.get(TARGET)).toBe(editado);
  });

  it('todo se escribe dentro de la carpeta del vault', async () => {
    const { fs, files, dirs } = memoryFs();
    await writeVaultFile(fs, ROOT, file('x', `${safeFileName('../../fuera', 'y')}.md`));

    const prefijo = join(ROOT, VAULT_FOLDER);
    expect([...files.keys()].every((path) => path.startsWith(prefijo))).toBe(true);
    expect(dirs.every((path) => path.startsWith(prefijo))).toBe(true);
  });
});

describe('writeVaultFiles', () => {
  it('reparte los ficheros entre escritos, sin cambios y conflictos', async () => {
    const { fs, files } = memoryFs();
    files.set(inVault('documents/ajeno.md'), '# del usuario');
    await writeVaultFile(fs, ROOT, file('ya estaba', 'documents/viejo.md'));

    const report = await writeVaultFiles(fs, ROOT, [
      file('nuevo', 'documents/nuevo.md'),
      file('ya estaba', 'documents/viejo.md'),
      file('intento', 'documents/ajeno.md'),
    ]);

    expect(report).toEqual({
      written: ['documents/nuevo.md'],
      unchanged: ['documents/viejo.md'],
      conflicts: [{ path: 'documents/ajeno.md', reason: 'ajeno' }],
    });
  });
});
