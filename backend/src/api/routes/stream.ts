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

function handleRunMessage(
  deps: StreamRouterDeps,
  channel: SseChannel,
  runId: string,
  message: string,
): void {
  const parsed = runEventSchema.safeParse(safeJson(message));
  if (!parsed.success) {
    deps.logger.warn({ runId }, 'evento de run ilegible, se descarta');
    return;
  }
  emit(channel, parsed.data);
  if (parsed.data.type === 'done') {
    channel.close();
  }
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

          if (isTerminal(run.status)) {
            emit(channel, {
              type: 'status',
              runId: run.id,
              status: run.status,
              barsTotal: run.barsTotal ?? 0,
            });
            emit(channel, { type: 'done', runId: run.id, status: run.status });
            channel.close();
            return;
          }

          // El run no era terminal en esta lectura, pero puede terminar y publicar
          // "done" mientras nos suscribimos (Redis pub/sub no reproduce mensajes
          // pasados). Nos suscribimos ANTES de confiar en el estado y bufferizamos
          // lo que llegue hasta releer el run despues de estar ya suscritos: eso
          // cierra la ventana de carrera.
          let live = false;
          const buffered: string[] = [];

          await attach(deps, channel, runChannel(run.id), (message) => {
            if (live) {
              handleRunMessage(deps, channel, run.id, message);
            } else {
              buffered.push(message);
            }
          });

          if (channel.closed) {
            return;
          }

          const current = await deps.runs.getRun(run.id);
          const status = current?.status ?? run.status;
          const barsTotal = current?.barsTotal ?? run.barsTotal ?? 0;

          emit(channel, { type: 'status', runId: run.id, status, barsTotal });

          if (isTerminal(status)) {
            emit(channel, { type: 'done', runId: run.id, status });
            channel.close();
            return;
          }

          live = true;
          for (const message of buffered) {
            handleRunMessage(deps, channel, run.id, message);
            if (channel.closed) {
              break;
            }
          }
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
