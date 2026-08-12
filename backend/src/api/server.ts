import compression from 'compression';
import cors from 'cors';
import express, {
  Router,
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import helmet from 'helmet';
import type { AppLogger } from '../observability/logger.js';
import { AppError } from './errors.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { requestId } from './middleware/request-id.js';
import { healthRouter, type HealthDeps } from './routes/health.js';

export const BODY_LIMIT = '32kb';

export interface ApiDeps extends HealthDeps {
  readonly logger: AppLogger;
  readonly webOrigin: string;
  readonly generateRequestId?: () => string;
  readonly registerRoutes?: (router: Router) => void;
}

function accessLog(logger: AppLogger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.on('finish', () => {
      const id: unknown = res.locals.requestId;
      logger.info(
        {
          requestId: typeof id === 'string' ? id : undefined,
          method: req.method,
          path: req.path,
          status: res.statusCode,
        },
        'peticion',
      );
    });
    next();
  };
}

export function createApiApp(deps: ApiDeps): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(
    cors({
      origin: (origin, callback) => {
        if (origin === undefined || origin === deps.webOrigin) {
          callback(null, true);
          return;
        }
        callback(new AppError('VALIDATION_ERROR', `Origen no permitido: ${origin}`));
      },
    }),
  );
  app.use(
    compression({
      filter: (req: Request, res: Response) => {
        const contentType = res.getHeader('Content-Type');
        if (typeof contentType === 'string' && contentType.includes('text/event-stream')) {
          return false;
        }
        return compression.filter(req, res);
      },
    }),
  );
  app.use(express.json({ limit: BODY_LIMIT }));
  app.use(
    deps.generateRequestId === undefined ? requestId() : requestId(deps.generateRequestId),
  );
  app.use(accessLog(deps.logger));

  const api = Router();
  api.use(healthRouter(deps));
  deps.registerRoutes?.(api);
  app.use('/api', api);

  app.use(notFoundHandler());
  app.use(errorHandler(deps.logger));

  return app;
}
