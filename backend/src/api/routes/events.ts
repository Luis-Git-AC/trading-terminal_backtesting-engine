import { eventsQuerySchema, type EventsResponse } from '@tt/shared';
import { Router } from 'express';
import { withValidation } from '../middleware/validate.js';
import { getMarketEvents, type MacroServiceDeps } from '../services/macro.service.js';

export function eventsRouter(deps: MacroServiceDeps): Router {
  const router = Router();

  router.get(
    '/events',
    withValidation({ query: eventsQuerySchema }, ({ query }, _req, res, next) => {
      getMarketEvents(deps, query)
        .then((payload: EventsResponse) => {
          res.json(payload);
        })
        .catch(next);
    }),
  );

  return router;
}
