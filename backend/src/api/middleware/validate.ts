import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodType } from 'zod';
import { AppError, type ErrorDetail } from '../errors.js';

export interface ValidationSchemas<P, Q, B> {
  readonly params?: ZodType<P>;
  readonly query?: ZodType<Q>;
  readonly body?: ZodType<B>;
}

export interface ValidatedInput<P, Q, B> {
  readonly params: P;
  readonly query: Q;
  readonly body: B;
}

export type ValidatedHandler<P, Q, B> = (
  input: ValidatedInput<P, Q, B>,
  req: Request,
  res: Response,
  next: NextFunction,
) => void;

function toDetails(
  section: string,
  issues: readonly { path: PropertyKey[]; message: string }[],
): ErrorDetail[] {
  return issues.map((issue) => {
    const path = issue.path.map((segment) => String(segment)).join('.');
    return { path: path === '' ? section : `${section}.${path}`, message: issue.message };
  });
}

export function withValidation<P = undefined, Q = undefined, B = undefined>(
  schemas: ValidationSchemas<P, Q, B>,
  handler: ValidatedHandler<P, Q, B>,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const raw: { params: unknown; query: unknown; body: unknown } = req;
    const details: ErrorDetail[] = [];

    let params: P | undefined;
    let query: Q | undefined;
    let body: B | undefined;

    if (schemas.params !== undefined) {
      const result = schemas.params.safeParse(raw.params);
      if (result.success) {
        params = result.data;
      } else {
        details.push(...toDetails('params', result.error.issues));
      }
    }

    if (schemas.query !== undefined) {
      const result = schemas.query.safeParse(raw.query);
      if (result.success) {
        query = result.data;
      } else {
        details.push(...toDetails('query', result.error.issues));
      }
    }

    if (schemas.body !== undefined) {
      const result = schemas.body.safeParse(raw.body);
      if (result.success) {
        body = result.data;
      } else {
        details.push(...toDetails('body', result.error.issues));
      }
    }

    if (details.length > 0) {
      next(AppError.validation('La peticion no cumple el contrato', details));
      return;
    }

    handler(
      { params: params as P, query: query as Q, body: body as B },
      req,
      res,
      next,
    );
  };
}
