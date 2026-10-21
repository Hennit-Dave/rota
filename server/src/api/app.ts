import express from 'express';
import { createLogger, type Logger } from '../http/logger.js';
import { installPostRoutes, installPreRoutes } from '../http/pipeline.js';

export interface AppDeps {
  logger?: Logger;
}

export function createApp(deps: AppDeps = {}) {
  const logger = deps.logger ?? createLogger();
  const app = express();
  installPreRoutes(app, logger);

  // Health checks never touch Postgres or Valkey (data.md).
  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  installPostRoutes(app, logger);
  return app;
}
