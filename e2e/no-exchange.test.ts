import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const read = (relative: string): string => readFileSync(join(ROOT, relative), 'utf8');

const EXCHANGE_HOSTS = /api\.bitget\.com|ws\.bitget\.com/;

function sourceFiles(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(entry.parentPath, entry.name));
}

describe('el stack E2E no habla con el exchange', () => {
  const compose = read('docker-compose.e2e.yml');
  const envFile = read('.env.e2e');

  it('.env.e2e apunta las URLs del exchange al puerto discard, no a bitget', () => {
    expect(envFile).toMatch(/^EXCHANGE_REST_URL=http:\/\/127\.0\.0\.1:9$/m);
    expect(envFile).toMatch(/^EXCHANGE_WS_URL=ws:\/\/127\.0\.0\.1:9$/m);
    expect(envFile).not.toMatch(EXCHANGE_HOSTS);
  });

  it('el compose no levanta ningun servicio con el rol ingestor', () => {
    expect(compose).not.toMatch(/main\.ts['" ]*,?\s*['"]?ingestor/);
    expect(compose).toMatch(/^ {2}emitter:$/m);
    expect(envFile).toMatch(/^INGEST_IN_WORKER=false$/m);
  });

  it('el compose resuelve los hosts del exchange a loopback en todos los contenedores de app', () => {
    expect(compose).toMatch(/api\.bitget\.com:127\.0\.0\.1/);
    expect(compose).toMatch(/ws\.bitget\.com:127\.0\.0\.1/);
  });

  it('ningun fuente de e2e/ ni scripts/ nombra el host del exchange', () => {
    const offenders = [...sourceFiles('e2e'), ...sourceFiles('scripts')].filter((file) =>
      EXCHANGE_HOSTS.test(readFileSync(file, 'utf8')),
    );

    expect(offenders).toEqual([]);
  });

  it('el emisor sustituye al ingestor y no abre ningun WebSocket', () => {
    const emitter = read('e2e/emitter.ts');

    expect(emitter).not.toMatch(/\bfrom 'ws'|new WebSocket|createBitget/);
    expect(emitter).toMatch(/createCandlePublisher/);
  });
});
