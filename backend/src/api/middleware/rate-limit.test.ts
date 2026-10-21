import type { Router } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../../observability/logger.js';
import { createApiApp } from '../server.js';
import { createBacktestRateLimit, DEFAULT_MAX_CREATE, DEFAULT_WINDOW_MS } from './rate-limit.js';

function makeApp(max: number) {
  return createApiApp({
    logger: createLogger({ role: 'api', level: 'silent' }),
    webOrigin: 'https://terminal.example',
    checkDb: () => Promise.resolve(),
    checkRedis: () => Promise.resolve(),
    uptimeSec: () => 1,
    version: '0.1.0',
    registerRoutes: (router: Router) => {
      const limiter = createBacktestRateLimit({ max, windowMs: DEFAULT_WINDOW_MS });
      router.post('/backtests', limiter, (_req, res) => {
        res.status(202).json({ ok: true });
      });
      router.get('/backtests', (_req, res) => {
        res.json({ runs: [] });
      });
    },
  });
}

describe('rate limit de POST /api/backtests', () => {
  it('deja pasar hasta el maximo y corta el resto con 429', async () => {
    const app = makeApp(3);

    const accepted = [];
    for (let i = 0; i < 3; i += 1) {
      accepted.push((await request(app).post('/api/backtests').send({})).status);
    }
    const blocked = await request(app).post('/api/backtests').send({});

    expect(accepted).toEqual([202, 202, 202]);
    expect(blocked.status).toBe(429);
  });

  it('el 429 usa el envelope de error del contrato, no el texto de la libreria', async () => {
    const app = makeApp(1);

    await request(app).post('/api/backtests').send({});
    const blocked = await request(app).post('/api/backtests').send({});

    expect(blocked.body).toEqual({
      error: {
        code: 'RATE_LIMITED',
        message: expect.stringContaining('maximo es 1'),
      },
    });
    expect(blocked.headers['content-type']).toContain('application/json');
  });

  it('una rafaga de 100 peticiones no tumba el API: el resto sigue respondiendo', async () => {
    const app = makeApp(DEFAULT_MAX_CREATE);

    const statuses = await Promise.all(
      Array.from({ length: 100 }, () => request(app).post('/api/backtests').send({})),
    ).then((responses) => responses.map((response) => response.status));

    const accepted = statuses.filter((status) => status === 202).length;
    const limited = statuses.filter((status) => status === 429).length;

    expect(accepted).toBe(DEFAULT_MAX_CREATE);
    expect(limited).toBe(100 - DEFAULT_MAX_CREATE);
    expect(statuses.every((status) => status === 202 || status === 429)).toBe(true);

    const afterBurst = await request(app).get('/api/health');
    expect(afterBurst.status).toBe(200);
    const otherRoute = await request(app).get('/api/backtests');
    expect(otherRoute.status).toBe(200);
  });

  it('expone las cabeceras estandar de rate limit y ninguna legacy', async () => {
    const app = makeApp(5);

    const response = await request(app).post('/api/backtests').send({});

    expect(response.headers['ratelimit-policy']).toContain('5');
    expect(response.headers['x-ratelimit-limit']).toBeUndefined();
  });
});
