import type { Express } from 'express';
import { createErrorHandler, notFoundHandler } from './errors.js';
import { requestLogger, type Logger } from './logger.js';
import { requestIdMiddleware } from './requestId.js';

/** Everything that must run before any route: request ID first, then the request log that reads it. */
export function installPreRoutes(app: Express, logger: Logger): void {
  app.disable('x-powered-by');
  app.use(requestIdMiddleware);
  app.use(requestLogger(logger));
}

/** Everything that must run after all routes: the JSON 404, then the one error handler. */
export function installPostRoutes(app: Express, logger: Logger): void {
  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));
}
