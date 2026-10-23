import { macroParamsSchema, macroQuerySchema, type MacroSeriesResponse } from '@tt/shared';
import { Router } from 'express';
import { withValidation } from '../middleware/validate.js';
import { getMacroSeries, type MacroServiceDeps } from '../services/macro.service.js';

export function macroRouter(deps: MacroServiceDeps): Router {
  const router = Router();

  router.get(
    '/macro/series/:seriesId',
    withValidation(
      { params: macroParamsSchema, query: macroQuerySchema },
      ({ params, query }, _req, res, next) => {
        getMacroSeries(deps, { seriesId: params.seriesId, ...query })
          .then((payload: MacroSeriesResponse) => {
            res.json(payload);
          })
          .catch(next);
      },
    ),
  );

  return router;
}
