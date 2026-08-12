import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

export const REQUEST_ID_HEADER = 'x-request-id';

export function requestId(generate: () => string = randomUUID): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const incoming = req.get(REQUEST_ID_HEADER);
    const id = incoming !== undefined && incoming.trim() !== '' ? incoming : generate();
    res.locals.requestId = id;
    res.setHeader(REQUEST_ID_HEADER, id);
    next();
  };
}
