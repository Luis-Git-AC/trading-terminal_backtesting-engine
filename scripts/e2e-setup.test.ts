import { describe, expect, it, vi } from 'vitest';
import { apiUrlFrom, isHealthy, probeHealth, summarizeSeed } from './e2e-setup.js';

const healthy = {
  status: 'ok',
  uptimeSec: 3,
  version: '0.1.0',
  checks: { db: 'ok', redis: 'ok' },
};

function response(body: unknown): Response {
  return { json: () => Promise.resolve(body) } as unknown as Response;
}

describe('isHealthy', () => {
  it('acepta el cuerpo con db y redis en ok', () => {
    expect(isHealthy(healthy)).toBe(true);
  });

  it('rechaza si redis o db no estan en ok', () => {
    expect(isHealthy({ ...healthy, checks: { db: 'ok', redis: 'error' } })).toBe(false);
    expect(isHealthy({ ...healthy, checks: { db: 'error', redis: 'ok' } })).toBe(false);
  });

  it('acepta status degraded mientras db y redis esten en ok', () => {
    expect(isHealthy({ ...healthy, status: 'degraded' })).toBe(true);
  });

  it('rechaza cuerpos que no son del contrato', () => {
    expect(isHealthy(undefined)).toBe(false);
    expect(isHealthy('ok')).toBe(false);
    expect(isHealthy({})).toBe(false);
    expect(isHealthy({ status: 'ok', checks: { db: 'ok' } })).toBe(false);
  });
});

describe('probeHealth', () => {
  it('devuelve el cuerpo cuando el API esta sano', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(response(healthy)));

    await expect(
      probeHealth({ url: 'http://x/api/health', fetchImpl: fetchImpl }),
    ).resolves.toMatchObject({ status: 'ok', version: '0.1.0' });
    expect(fetchImpl).toHaveBeenCalledWith('http://x/api/health');
  });

  it('devuelve undefined cuando no lo esta, para que waitFor reintente', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(response({ ...healthy, checks: { db: 'error', redis: 'ok' } })),
    );

    await expect(probeHealth({ url: 'http://x', fetchImpl: fetchImpl })).resolves.toBeUndefined();
  });

  it('propaga el fallo de red para que waitFor lo cuente como intento fallido', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error('ECONNREFUSED')));

    await expect(probeHealth({ url: 'http://x', fetchImpl: fetchImpl })).rejects.toThrow(
      'ECONNREFUSED',
    );
  });
});

describe('apiUrlFrom', () => {
  it('usa el 4000 por defecto, que es el del bloque de verificacion del ticket', () => {
    expect(apiUrlFrom({})).toBe('http://localhost:4000');
  });

  it('respeta E2E_API_PORT y, por encima, E2E_API_URL', () => {
    expect(apiUrlFrom({ E2E_API_PORT: '4100' })).toBe('http://localhost:4100');
    expect(apiUrlFrom({ E2E_API_PORT: '4100', E2E_API_URL: 'http://otro:9' })).toBe(
      'http://otro:9',
    );
  });
});

describe('summarizeSeed', () => {
  it('imprime el rango en ISO para que quede en el log del arranque', () => {
    const text = summarizeSeed([
      {
        symbol: 'BTCUSDT',
        timeframe: '15m',
        bars: 2000,
        written: 2000,
        fromTs: Date.parse('2026-07-01T00:00:00Z'),
        toTs: Date.parse('2026-07-21T19:45:00Z'),
      },
    ]);

    expect(text).toContain('BTCUSDT 15m: 2000 vela(s), 2000 escrita(s)');
    expect(text).toContain('2026-07-01T00:00:00.000Z -> 2026-07-21T19:45:00.000Z');
  });
});
