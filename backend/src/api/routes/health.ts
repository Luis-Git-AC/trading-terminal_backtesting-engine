import { Router, type Request, type Response } from 'express';

export const CHECK_STATES = ['ok', 'error'] as const;

export type CheckState = (typeof CHECK_STATES)[number];

export interface IngestHealthSummary {
  readonly status: 'ok' | 'degraded';
  readonly lastCandleAgeSec: number | null;
}

export interface HealthDeps {
  readonly checkDb: () => Promise<void>;
  readonly checkRedis: () => Promise<void>;
  readonly ingestHealth?: () => Promise<IngestHealthSummary>;
  readonly uptimeSec: () => number;
  readonly version: string;
}

export interface HealthBody {
  readonly status: 'ok' | 'degraded';
  readonly uptimeSec: number;
  readonly version: string;
  readonly checks: {
    readonly db: CheckState;
    readonly redis: CheckState;
    readonly ingest?: IngestHealthSummary | CheckState;
  };
}

async function probe(check: () => Promise<void>): Promise<CheckState> {
  try {
    await check();
    return 'ok';
  } catch {
    return 'error';
  }
}

export function healthRouter(deps: HealthDeps): Router {
  const router = Router();

  router.get('/health', (_req: Request, res: Response<HealthBody>) => {
    void (async () => {
      const [db, redis] = await Promise.all([probe(deps.checkDb), probe(deps.checkRedis)]);

      let ingest: IngestHealthSummary | CheckState | undefined;
      if (deps.ingestHealth !== undefined) {
        try {
          ingest = await deps.ingestHealth();
        } catch {
          ingest = 'error';
        }
      }

      const ingestDegraded =
        ingest !== undefined && (typeof ingest === 'string' || ingest.status !== 'ok');
      const healthy = db === 'ok' && redis === 'ok' && !ingestDegraded;

      res.status(db === 'ok' ? 200 : 503).json({
        status: healthy ? 'ok' : 'degraded',
        uptimeSec: deps.uptimeSec(),
        version: deps.version,
        checks: {
          db,
          redis,
          ...(ingest === undefined ? {} : { ingest }),
        },
      });
    })();
  });

  return router;
}
