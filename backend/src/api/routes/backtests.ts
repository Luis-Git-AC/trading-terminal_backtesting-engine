import {
  compareQuerySchema,
  createBacktestBodySchema,
  listBacktestsQuerySchema,
  runIdParamsSchema,
  tradesQuerySchema,
} from '@tt/shared';
import { Router } from 'express';
import { withValidation } from '../middleware/validate.js';
import {
  cancelBacktest,
  compareBacktests,
  createBacktest,
  deleteBacktest,
  getBacktest,
  getBacktestEquity,
  getBacktestTrades,
  listBacktests,
  type BacktestsServiceDeps,
} from '../services/backtests.service.js';

export function backtestsRouter(deps: BacktestsServiceDeps): Router {
  const router = Router();

  router.post(
    '/backtests',
    withValidation({ body: createBacktestBodySchema }, ({ body }, _req, res, next) => {
      createBacktest(deps, body)
        .then((payload) => {
          res.status(202).json(payload);
        })
        .catch(next);
    }),
  );

  router.get(
    '/backtests',
    withValidation({ query: listBacktestsQuerySchema }, ({ query }, _req, res, next) => {
      listBacktests(deps, query)
        .then((payload) => {
          res.json(payload);
        })
        .catch(next);
    }),
  );

  router.get(
    '/backtests/compare',
    withValidation({ query: compareQuerySchema }, ({ query }, _req, res, next) => {
      compareBacktests(deps, query.ids)
        .then((payload) => {
          res.json(payload);
        })
        .catch(next);
    }),
  );

  router.get(
    '/backtests/:id',
    withValidation({ params: runIdParamsSchema }, ({ params }, _req, res, next) => {
      getBacktest(deps, params.id)
        .then((payload) => {
          res.json(payload);
        })
        .catch(next);
    }),
  );

  router.get(
    '/backtests/:id/trades',
    withValidation(
      { params: runIdParamsSchema, query: tradesQuerySchema },
      ({ params, query }, _req, res, next) => {
        getBacktestTrades(deps, params.id, query)
          .then((payload) => {
            res.json(payload);
          })
          .catch(next);
      },
    ),
  );

  router.get(
    '/backtests/:id/equity',
    withValidation({ params: runIdParamsSchema }, ({ params }, _req, res, next) => {
      getBacktestEquity(deps, params.id)
        .then((payload) => {
          res.json(payload);
        })
        .catch(next);
    }),
  );

  router.post(
    '/backtests/:id/cancel',
    withValidation({ params: runIdParamsSchema }, ({ params }, _req, res, next) => {
      cancelBacktest(deps, params.id)
        .then((payload) => {
          res.json(payload);
        })
        .catch(next);
    }),
  );

  router.delete(
    '/backtests/:id',
    withValidation({ params: runIdParamsSchema }, ({ params }, _req, res, next) => {
      deleteBacktest(deps, params.id)
        .then(() => {
          res.status(204).end();
        })
        .catch(next);
    }),
  );

  return router;
}
