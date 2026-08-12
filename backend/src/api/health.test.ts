import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../observability/logger.js';
import { AppError } from './errors.js';
import { createApiApp, type ApiDeps } from './server.js';

const WEB_ORIGIN = 'https://terminal.example';

function silentLogger() {
  return createLogger({ role: 'api', level: 'silent' });
}

function makeApp(overrides: Partial<ApiDeps> = {}) {
  const deps: ApiDeps = {
    logger: silentLogger(),
    webOrigin: WEB_ORIGIN,
    checkDb: () => Promise.resolve(),
    checkRedis: () => Promise.resolve(),
    uptimeSec: () => 1234,
    version: '0.1.0',
    ...overrides,
  };
  return createApiApp(deps);
}

describe('GET /api/health', () => {
  it('devuelve 200 con los tres checks cuando todo responde', async () => {
    const app = makeApp({
      ingestHealth: () => Promise.resolve({ status: 'ok', lastCandleAgeSec: 12 }),
    });

    const response = await request(app).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: 'ok',
      uptimeSec: 1234,
      version: '0.1.0',
      checks: {
        db: 'ok',
        redis: 'ok',
        ingest: { status: 'ok', lastCandleAgeSec: 12 },
      },
    });
  });

  it('con la BD caida devuelve 503 y checks.db = error', async () => {
    const app = makeApp({
      checkDb: () => Promise.reject(new Error('connection refused')),
    });

    const response = await request(app).get('/api/health');

    expect(response.status).toBe(503);
    expect(response.body.status).toBe('degraded');
    expect(response.body.checks.db).toBe('error');
    expect(response.body.checks.redis).toBe('ok');
  });

  it('con Redis caido sigue sirviendo 200 pero se marca degradado', async () => {
    const app = makeApp({
      checkRedis: () => Promise.reject(new Error('ECONNREFUSED')),
    });

    const response = await request(app).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('degraded');
    expect(response.body.checks.redis).toBe('error');
  });

  it('una ingesta degradada degrada la salud sin tumbar el servicio', async () => {
    const app = makeApp({
      ingestHealth: () => Promise.resolve({ status: 'degraded', lastCandleAgeSec: 900 }),
    });

    const response = await request(app).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('degraded');
    expect(response.body.checks.ingest).toEqual({ status: 'degraded', lastCandleAgeSec: 900 });
  });

  it('si getIngestHealth revienta, el check sale error y no propaga la excepcion', async () => {
    const app = makeApp({
      ingestHealth: () => Promise.reject(new Error('boom')),
    });

    const response = await request(app).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body.checks.ingest).toBe('error');
  });

  it('sin ingesta configurada el check no aparece', async () => {
    const response = await request(makeApp()).get('/api/health');
    expect(response.body.checks.ingest).toBeUndefined();
  });
});

describe('sobre de error del contrato', () => {
  it('una ruta inexistente devuelve 404 con el sobre documentado', async () => {
    const response = await request(makeApp()).get('/api/no-existe');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: expect.stringContaining('/api/no-existe'),
      },
    });
  });

  it('una excepcion no controlada no filtra el stack pero si se logea', async () => {
    const logger = silentLogger();
    const errorSpy = vi.spyOn(logger, 'error');
    const app = createApiApp({
      logger,
      webOrigin: WEB_ORIGIN,
      checkDb: () => Promise.resolve(),
      checkRedis: () => Promise.resolve(),
      uptimeSec: () => 1,
      version: '0.1.0',
      registerRoutes: (router) => {
        router.get('/boom', () => {
          throw new Error('secreto interno con stack');
        });
      },
    });

    const response = await request(app).get('/api/boom');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: { code: 'INTERNAL', message: 'Error interno del servidor' },
    });
    expect(JSON.stringify(response.body)).not.toContain('secreto interno');
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('un AppError de cliente se serializa con su codigo y sus details', async () => {
    const app = makeApp({
      registerRoutes: (router) => {
        router.get('/malo', (_req, _res, next) => {
          next(
            AppError.validation('La peticion no cumple el contrato', [
              { path: 'query.limit', message: 'Debe ser un entero' },
            ]),
          );
        });
      },
    });

    const response = await request(app).get('/api/malo');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.details).toEqual([
      { path: 'query.limit', message: 'Debe ser un entero' },
    ]);
  });
});

describe('middlewares transversales', () => {
  it('cada respuesta lleva un x-request-id', async () => {
    const response = await request(makeApp()).get('/api/health');
    expect(response.headers['x-request-id']).toMatch(/[0-9a-f-]{36}/);
  });

  it('respeta el x-request-id que llega del cliente', async () => {
    const response = await request(makeApp())
      .get('/api/health')
      .set('x-request-id', 'trace-123');
    expect(response.headers['x-request-id']).toBe('trace-123');
  });

  it('CORS acepta el origen configurado', async () => {
    const response = await request(makeApp()).get('/api/health').set('Origin', WEB_ORIGIN);
    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
  });

  it('CORS rechaza cualquier otro origen', async () => {
    const response = await request(makeApp())
      .get('/api/health')
      .set('Origin', 'https://atacante.example');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('helmet quita x-powered-by y pone cabeceras de seguridad', async () => {
    const response = await request(makeApp()).get('/api/health');
    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('un body por encima del limite se rechaza con 413, no como error interno', async () => {
    const app = makeApp({
      registerRoutes: (router) => {
        router.post('/echo', (_req, res) => {
          res.json({ ok: true });
        });
      },
    });

    const response = await request(app)
      .post('/api/echo')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ blob: 'x'.repeat(64 * 1024) }));

    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe('RANGE_TOO_LARGE');
  });

  it('express.json deja el body parseado disponible', async () => {
    const app = makeApp({
      registerRoutes: (router) => {
        router.post('/echo', (req, res) => {
          res.json(req.body);
        });
      },
    });

    const response = await request(app).post('/api/echo').send({ hola: 'mundo' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ hola: 'mundo' });
  });
});
