import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodType } from 'zod';
import { AppError, type ErrorDetail } from '../errors.js';

export interface ValidationSchemas {
  readonly params?: ZodType;
  readonly query?: ZodType;
  readonly body?: ZodType;
}

export interface ValidatedRequest {
  readonly params: unknown;
  readonly query: unknown;
  readonly body: unknown;
}

const VALIDATED = new WeakMap<Response, ValidatedRequest>();

function toDetails(issues: readonly { path: PropertyKey[]; message: string }[]): ErrorDetail[] {
  return issues.map((issue) => ({
    path: issue.path.map((segment) => String(segment)).join('.'),
    message: issue.message,
  }));
}

export function validate(schemas: ValidationSchemas): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const raw: { params: unknown; query: unknown; body: unknown } = req;

    const sections = [
      { key: 'params', schema: schemas.params, value: raw.params },
      { key: 'query', schema: schemas.query, value: raw.query },
      { key: 'body', schema: schemas.body, value: raw.body },
    ] as const;

    const details: ErrorDetail[] = [];
    let params: unknown = raw.params;
    let query: unknown = raw.query;
    let body: unknown = raw.body;

    for (const section of sections) {
      if (section.schema === undefined) {
        continue;
      }
      const result = section.schema.safeParse(section.value);
      if (!result.success) {
        details.push(
          ...toDetails(result.error.issues).map((detail) => ({
            path: detail.path === '' ? section.key : `${section.key}.${detail.path}`,
            message: detail.message,
          })),
        );
        continue;
      }
      if (section.key === 'params') {
        params = result.data;
      } else if (section.key === 'query') {
        query = result.data;
      } else {
        body = result.data;
      }
    }

    if (details.length > 0) {
      next(AppError.validation('La peticion no cumple el contrato', details));
      return;
    }

    VALIDATED.set(res, { params, query, body });
    next();
  };
}

export function validated(res: Response): ValidatedRequest {
  const value = VALIDATED.get(res);
  if (value === undefined) {
    throw new Error('validate() no se ejecuto antes de leer los datos validados');
  }
  return value;
}
