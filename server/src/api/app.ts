import express from 'express';
import { createAuthRouter, type AuthDeps } from '../auth/routes.js';
import { createLogger, type Logger } from '../http/logger.js';
import { installPostRoutes, installPreRoutes } from '../http/pipeline.js';
import { createInvitationsRouter, type InvitesRouteDeps } from '../invites/routes.js';
import { createTeamsRouter, type TeamsDeps } from '../teams/routes.js';

export interface AppDeps {
  logger?: Logger;
  /** When given, mounts /auth. Left out by tests that only need the bare app. */
  auth?: Omit<AuthDeps, 'logger'>;
  /** When given, mounts /teams. */
  teams?: Omit<TeamsDeps, 'logger'>;
  /** When given, mounts /invitations (preview and accept). */
  invitations?: Omit<InvitesRouteDeps, 'logger'>;
}

export function createApp(deps: AppDeps = {}) {
  const logger = deps.logger ?? createLogger();
  const app = express();
  installPreRoutes(app, logger);

  // Health checks never touch Postgres or Valkey (data.md).
  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  if (deps.auth) {
    app.use('/auth', createAuthRouter({ ...deps.auth, logger }));
  }
  if (deps.teams) {
    app.use('/teams', createTeamsRouter({ ...deps.teams, logger }));
  }
  if (deps.invitations) {
    app.use('/invitations', createInvitationsRouter({ ...deps.invitations, logger }));
  }

  installPostRoutes(app, logger);
  return app;
}
