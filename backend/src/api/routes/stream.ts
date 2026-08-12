import {
  candleTickSchema,
  runChannel,
  runEventSchema,
  runIdParamsSchema,
  timeframeSchema,
  symbolSchema,
  type RunEvent,
  type Timeframe,
} from '@tt/shared';
import { Router, type Response } from 'express';
import { z } from 'zod';
import type { RunsRepository } from '../../db/repositories/runs.repo.js';
import type { AppLogger } from '../../observability/logger.js';
import { candleChannel } from '../../queue/pubsub.js';
import { AppError } from '../errors.js';
import { withValidation } from '../middleware/validate.js';
import { sseChannel, type SseChannel, type SseChannelOptions } from '../sse/channel.js';
import type { SseHub } from '../sse/hub.js';

const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'] as const;

export const candleStreamQuerySchema = z.object({
  symbol: symbolSchema,
  timeframe: timeframeSchema,
});

export interface StreamRouterDeps {
  readonly runs: RunsRepository;
  readonly hub: SseHub;
  readonly logger: AppLogger;
  readonly symbols: readonly string[];
  readonly timeframes: readonly Timeframe[];
  readonly sse?: SseChannelOptions | undefined;
}

function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES.some((terminal) => terminal === status);
}

function emit(channel: SseChannel, event: RunEvent): void {
  const { type, ...payload } = event;
  channel.send(type, payload);
}

function openChannel(deps: StreamRouterDeps, res: Response): SseChannel {
  return sseChannel(res, deps.sse ?? {});
}

function attach(
  deps: StreamRouterDeps,
  channel: SseChannel,
  redisChannel: string,
  onMessage: (message: string) => void,
): Promise<void> {
  return deps.hub
    .subscribe(redisChannel, onMessage)
    .then((release) => {
      if (channel.closed) {
        void release();
        return;
      }
      channel.onClose(() => {
        void release();
      });
    })
    .catch((error: unknown) => {
      deps.logger.error({ err: error, channel: redisChannel }, 'no se pudo abrir la suscripcion sse');
      channel.send('error', { code: 'INTERNAL', message: 'No se pudo abrir el stream' });
      channel.close();
    });
}

export function streamRouter(deps: StreamRouterDeps): Router {
  const router = Router();

  router.get(
    '/backtests/:id/stream',
    withValidation({ params: runIdParamsSchema }, ({ params }, _req, res, next) => {
      deps.runs
        .getRun(params.id)
        .then(async (run) => {
          if (run === null) {
            next(AppError.notFound(`No existe el backtest ${params.id}`));
            return;
          }

          const channel = openChannel(deps, res);

          emit(channel, {
            type: 'status',
            runId: run.id,
            status: run.status,
            barsTotal: run.barsTotal ?? 0,
          });

          if (isTerminal(run.status)) {
            emit(channel, { type: 'done', runId: run.id, status: run.status });
            channel.close();
            return;
          }

          await attach(deps, channel, runChannel(run.id), (message) => {
            const parsed = runEventSchema.safeParse(safeJson(message));
            if (!parsed.success) {
              deps.logger.warn({ runId: run.id }, 'evento de run ilegible, se descarta');
              return;
            }
            emit(channel, parsed.data);
            if (parsed.data.type === 'done') {
              channel.close();
            }
          });
        })
        .catch(next);
    }),
  );

  router.get(
    '/stream/candles',
    withValidation({ query: candleStreamQuerySchema }, ({ query }, _req, res, next) => {
      if (!deps.symbols.includes(query.symbol)) {
        next(AppError.notFound(`Simbolo no disponible: ${query.symbol}`));
        return;
      }
      if (!deps.timeframes.includes(query.timeframe)) {
        next(AppError.notFound(`Timeframe no disponible: ${query.timeframe}`));
        return;
      }

      const channel = openChannel(deps, res);

      void attach(
        deps,
        channel,
        candleChannel(query.symbol, query.timeframe),
        (message) => {
          const parsed = candleTickSchema.safeParse(safeJson(message));
          if (!parsed.success) {
            deps.logger.warn(
              { symbol: query.symbol, timeframe: query.timeframe },
              'tick ilegible, se descarta',
            );
            return;
          }
          channel.send('candle', parsed.data);
        },
      );
    }),
  );

  return router;
}

function safeJson(message: string): unknown {
  try {
    return JSON.parse(message);
  } catch {
    return null;
  }
}
