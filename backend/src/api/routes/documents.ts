import {
  documentParamsSchema,
  documentsSearchQuerySchema,
  type DocumentResponse,
  type DocumentsSearchResponse,
} from '@tt/shared';
import { Router } from 'express';
import { withValidation } from '../middleware/validate.js';
import {
  getDocument,
  searchDocuments,
  type SearchServiceDeps,
} from '../services/search.service.js';

export function documentsRouter(deps: SearchServiceDeps): Router {
  const router = Router();

  // Antes que `/documents/:id` a proposito: `search` encajaria en el patron del id si no.
  router.get(
    '/documents/search',
    withValidation({ query: documentsSearchQuerySchema }, ({ query }, _req, res, next) => {
      searchDocuments(deps, query)
        .then((payload: DocumentsSearchResponse) => {
          res.json(payload);
        })
        .catch(next);
    }),
  );

  router.get(
    '/documents/:id',
    withValidation({ params: documentParamsSchema }, ({ params }, _req, res, next) => {
      getDocument(deps, params.id)
        .then((payload: DocumentResponse) => {
          res.json(payload);
        })
        .catch(next);
    }),
  );

  return router;
}
