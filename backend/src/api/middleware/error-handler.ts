import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import type { AppLogger } from '../../observability/logger.js';
import { AppError } from '../errors.js';

export function notFoundHandler(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    next(AppError.notFound(`Ruta no encontrada: ${req.method} ${req.path}`));
  };
}

function normalizeBodyParserError(error: unknown): unknown {
  if (error instanceof AppError || typeof error !== 'object' || error === null) {
    return error;
  }
  const candidate: { type?: unknown } = error;
  if (candidate.type === 'entity.too.large') {
    return AppError.rangeTooLarge('El cuerpo de la peticion supera el limite admitido');
  }
  if (candidate.type === 'entity.parse.failed') {
    return AppError.validation('El cuerpo de la peticion no es JSON valido', [
      { path: 'body', message: 'JSON invalido' },
    ]);
  }
  return error;
}

export function errorHandler(logger: AppLogger): ErrorRequestHandler {
  return (error: unknown, req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) {
      next(error);
      return;
    }

    const requestId: unknown = res.locals.requestId;
    const context = {
      requestId: typeof requestId === 'string' ? requestId : undefined,
      method: req.method,
      path: req.path,
    };

    const normalized = normalizeBodyParserError(error);

    if (normalized instanceof AppError) {
      if (normalized.status >= 500) {
        logger.error({ ...context, code: normalized.code, err: error }, 'error de aplicacion');
      } else {
        logger.warn({ ...context, code: normalized.code }, 'peticion rechazada');
      }
      res.status(normalized.status).json(normalized.toEnvelope());
      return;
    }

    logger.error({ ...context, err: error }, 'excepcion no controlada');
    const internal = new AppError('INTERNAL', 'Error interno del servidor');
    res.status(internal.status).json(internal.toEnvelope());
  };
}
